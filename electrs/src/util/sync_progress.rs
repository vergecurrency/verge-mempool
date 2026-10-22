use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::metrics::{GaugeVec, MetricOpts, Metrics};

const REPORT_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct SyncMetrics {
    processed: GaugeVec,
    total: GaugeVec,
    reused: GaugeVec,
    active: GaugeVec,
}

impl SyncMetrics {
    pub fn new(metrics: &Metrics) -> Self {
        Self {
            processed: metrics.gauge_vec(
                MetricOpts::new(
                    "index_sync_processed",
                    "Items processed in the current phase run",
                ),
                &["phase"],
            ),
            total: metrics.gauge_vec(
                MetricOpts::new(
                    "index_sync_total",
                    "Items in the current phase run; -1 if unknown",
                ),
                &["phase"],
            ),
            reused: metrics.gauge_vec(
                MetricOpts::new(
                    "index_sync_reused",
                    "Persisted completion markers reused in this phase run",
                ),
                &["phase"],
            ),
            active: metrics.gauge_vec(
                MetricOpts::new(
                    "index_sync_active",
                    "Whether this synchronization phase is active",
                ),
                &["phase"],
            ),
        }
    }

    fn update(&self, state: &State, active: bool) {
        let labels = &[state.phase];
        self.processed
            .with_label_values(labels)
            .set(state.processed as f64);
        self.total
            .with_label_values(labels)
            .set(state.total.map_or(-1.0, |n| n as f64));
        self.reused
            .with_label_values(labels)
            .set(state.reused as f64);
        self.active
            .with_label_values(labels)
            .set(if active { 1.0 } else { 0.0 });
    }
}

struct State {
    phase: &'static str,
    unit: &'static str,
    total: Option<usize>,
    processed: usize,
    reused: usize,
    transactions: usize,
    height: Option<usize>,
    started: Instant,
    last_advance: Instant,
    metrics: Option<SyncMetrics>,
}

fn rate_and_eta(
    processed: usize,
    total: Option<usize>,
    elapsed: f64,
    idle: f64,
) -> (f64, Option<f64>) {
    let rate = if elapsed > 0.0 {
        processed as f64 / elapsed
    } else {
        0.0
    };
    let eta = total.and_then(|total| {
        if total == processed {
            Some(0.0)
        } else if rate > 0.0 && idle < REPORT_INTERVAL.as_secs_f64() * 3.0 {
            Some(total.saturating_sub(processed) as f64 / rate)
        } else {
            None
        }
    });
    (rate, eta)
}

impl State {
    fn report(&self, status: &str) {
        let elapsed = self.started.elapsed().as_secs_f64();
        let idle = self.last_advance.elapsed().as_secs_f64();
        let (rate, eta) = rate_and_eta(self.processed, self.total, elapsed, idle);
        let total = self
            .total
            .map_or_else(|| "unknown".into(), |n| n.to_string());
        let remaining = self.total.map_or_else(
            || "unknown".into(),
            |n| n.saturating_sub(self.processed).to_string(),
        );
        let percent = self.total.map_or_else(
            || "unknown".into(),
            |n| {
                format!(
                    "{:.2}",
                    if n == 0 {
                        100.0
                    } else {
                        self.processed as f64 * 100.0 / n as f64
                    }
                )
            },
        );
        let eta = eta.map_or_else(|| "unknown".into(), |n| format!("{n:.0}"));
        let height = self
            .height
            .map_or_else(|| "unknown".into(), |n| n.to_string());
        let missing = if self.unit == "markers" {
            self.processed.saturating_sub(self.reused).to_string()
        } else {
            "unknown".into()
        };
        info!(
            "sync phase={} state={} unit={} processed={} total={} remaining={} progress_pct={} reused={} missing_blocks={} transactions={} last_height={} rate_per_s={:.1} elapsed_s={:.0} idle_s={:.0} eta_s={}",
            self.phase, status, self.unit, self.processed, total, remaining, percent,
            self.reused, missing, self.transactions, height, rate, elapsed, idle, eta
        );
    }
}

/// Phase-local progress, not the published synchronized chain tip. The heartbeat
/// continues during a slow RPC/DB call or compaction without inventing progress.
pub(crate) struct SyncProgress {
    state: Arc<Mutex<State>>,
    stop: Option<mpsc::Sender<bool>>,
    thread: Option<JoinHandle<()>>,
}

impl SyncProgress {
    pub fn new(phase: &'static str, total: Option<usize>, unit: &'static str) -> Self {
        Self::start(phase, total, unit, None)
    }

    pub fn with_metrics(
        phase: &'static str,
        total: Option<usize>,
        unit: &'static str,
        metrics: &SyncMetrics,
    ) -> Self {
        Self::start(phase, total, unit, Some(metrics.clone()))
    }

    fn start(
        phase: &'static str,
        total: Option<usize>,
        unit: &'static str,
        metrics: Option<SyncMetrics>,
    ) -> Self {
        let now = Instant::now();
        let state = Arc::new(Mutex::new(State {
            phase,
            unit,
            total,
            processed: 0,
            reused: 0,
            transactions: 0,
            height: None,
            started: now,
            last_advance: now,
            metrics,
        }));
        {
            let state = state.lock().unwrap();
            if let Some(metrics) = &state.metrics {
                metrics.update(&state, true);
            }
            state.report("started");
        }
        let (stop, receiver) = mpsc::channel();
        let observed = Arc::clone(&state);
        let thread = crate::util::spawn_thread("sync_status", move || loop {
            let result = receiver.recv_timeout(REPORT_INTERVAL);
            let state = observed.lock().unwrap_or_else(|p| p.into_inner());
            match result {
                Err(mpsc::RecvTimeoutError::Timeout) => state.report("running"),
                result => {
                    if let Some(metrics) = &state.metrics {
                        metrics.update(&state, false);
                    }
                    state.report(if matches!(result, Ok(true)) {
                        "finished"
                    } else {
                        "interrupted"
                    });
                    break;
                }
            }
        });
        Self {
            state,
            stop: Some(stop),
            thread: Some(thread),
        }
    }

    pub fn update(
        &self,
        processed: usize,
        reused: usize,
        transactions: usize,
        height: Option<usize>,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.processed != processed {
            state.last_advance = Instant::now();
        }
        state.processed = processed;
        state.reused = reused;
        state.transactions = transactions;
        state.height = height;
        if let Some(metrics) = &state.metrics {
            metrics.update(&state, true);
        }
    }

    pub fn finish(mut self) {
        self.close(true);
    }

    fn close(&mut self, finished: bool) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(finished);
        }
        if let Some(thread) = self.thread.take() {
            // Diagnostic logging must not replace the indexing error during unwinding.
            let _ = thread.join();
        }
    }
}

impl Drop for SyncProgress {
    fn drop(&mut self) {
        self.close(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_work_keeps_reporting_without_advancing_and_joins_on_drop() {
        struct Capture;
        static RECORDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
        impl log::Log for Capture {
            fn enabled(&self, _: &log::Metadata<'_>) -> bool {
                true
            }
            fn log(&self, record: &log::Record<'_>) {
                if record.target() == module_path!().trim_end_matches("::tests") {
                    let line = record.args().to_string();
                    if line.contains("phase=heartbeat_test ") {
                        RECORDS.lock().unwrap().push(line);
                    }
                }
            }
            fn flush(&self) {}
        }
        log::set_logger(&Capture).unwrap();
        log::set_max_level(log::LevelFilter::Info);
        let progress = SyncProgress::new("heartbeat_test", Some(100), "blocks");
        progress.update(12, 0, 20, Some(11));
        let state = Arc::clone(&progress.state);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if RECORDS
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.contains("state=running"))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "heartbeat stopped during blocked work"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        drop(progress);
        assert_eq!(
            Arc::strong_count(&state),
            1,
            "reporter thread must be joined"
        );
        let records = RECORDS.lock().unwrap();
        for status in ["running", "interrupted"] {
            let line = records
                .iter()
                .find(|line| line.contains(&format!("state={status}")))
                .unwrap();
            assert!(line.contains("processed=12 total=100 remaining=88"));
            assert!(line.contains("transactions=20 last_height=11"));
            assert!(line.contains("idle_s="));
        }
    }

    #[test]
    fn unknown_or_stalled_work_has_no_invented_eta() {
        assert_eq!(rate_and_eta(0, Some(100), 2.0, 2.0), (0.0, None));
        assert_eq!(rate_and_eta(10, None, 2.0, 0.0), (5.0, None));
        assert_eq!(rate_and_eta(10, Some(100), 2.0, 0.0), (5.0, Some(18.0)));
        assert_eq!(rate_and_eta(10, Some(100), 20.0, 16.0), (0.5, None));
        assert_eq!(rate_and_eta(0, Some(0), 0.0, 0.0), (0.0, Some(0.0)));
    }

    #[test]
    fn interrupted_phase_keeps_measured_counts_and_clears_active_metric() {
        let metrics = Metrics::new("127.0.0.1:0".parse().unwrap());
        let gauges = SyncMetrics::new(&metrics);
        {
            let progress = SyncProgress::with_metrics("test", Some(100), "blocks", &gauges);
            progress.update(12, 3, 20, Some(18));
            assert_eq!(gauges.active.with_label_values(&["test"]).get(), 1.0);
        }
        assert_eq!(gauges.active.with_label_values(&["test"]).get(), 0.0);
        assert_eq!(gauges.processed.with_label_values(&["test"]).get(), 12.0);
        assert_eq!(gauges.total.with_label_values(&["test"]).get(), 100.0);
        assert_eq!(gauges.reused.with_label_values(&["test"]).get(), 3.0);
    }
}
