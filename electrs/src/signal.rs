use crossbeam_channel as channel;
use crossbeam_channel::RecvTimeoutError;
use std::time::{Duration, Instant};

#[cfg(unix)]
use signal_hook::consts::SIGUSR1;
use signal_hook::consts::{SIGINT, SIGTERM};

use crate::errors::*;

#[derive(Clone)] // so multiple threads could wait on signals
pub struct Waiter {
    receiver: channel::Receiver<i32>,
}

#[cfg(unix)]
fn notify(signals: &[i32]) -> channel::Receiver<i32> {
    let (s, r) = channel::bounded(1);
    let mut signals =
        signal_hook::iterator::Signals::new(signals).expect("failed to register signal hook");
    crate::util::spawn_thread("signal-notifier", move || {
        for signal in signals.forever() {
            s.send(signal)
                .unwrap_or_else(|_| panic!("failed to send signal {}", signal));
        }
    });
    r
}

#[cfg(windows)]
fn notify(signals: &[i32]) -> channel::Receiver<i32> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let pending = Arc::new(AtomicUsize::new(0));
    for &signal in signals {
        signal_hook::flag::register_usize(signal, Arc::clone(&pending), signal as usize)
            .expect("failed to register signal hook");
    }
    let (sender, receiver) = channel::bounded(1);
    crate::util::spawn_thread("signal-notifier", move || loop {
        let signal = pending.swap(0, Ordering::Relaxed);
        if signal != 0 && sender.send(signal as i32).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    });
    receiver
}

impl Waiter {
    pub fn start() -> Waiter {
        Waiter {
            receiver: notify(&[
                SIGINT,
                SIGTERM,
                #[cfg(unix)]
                SIGUSR1, // allow external triggering (e.g. via bitcoind `blocknotify`)
            ]),
        }
    }

    pub fn wait(&self, duration: Duration, accept_sigusr: bool) -> Result<()> {
        // Determine the deadline time based on the duration, so that it doesn't
        // get pushed back when wait_deadline() recurses
        self.wait_deadline(Instant::now() + duration, accept_sigusr)
    }

    fn wait_deadline(&self, deadline: Instant, accept_sigusr: bool) -> Result<()> {
        #[cfg(not(unix))]
        let _ = accept_sigusr;
        match self.receiver.recv_deadline(deadline) {
            #[cfg(unix)]
            Ok(sig) if sig == SIGUSR1 => {
                trace!("notified via SIGUSR1");
                if accept_sigusr {
                    Ok(())
                } else {
                    self.wait_deadline(deadline, accept_sigusr)
                }
            }
            Ok(sig) => bail!(ErrorKind::Interrupt(sig)),
            Err(RecvTimeoutError::Timeout) => Ok(()),
            Err(RecvTimeoutError::Disconnected) => bail!("signal hook channel disconnected"),
        }
    }
}
