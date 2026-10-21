/*
 * Copyright 2009 Colin Percival, 2011 ArtForz, 2012-2013 pooler
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 * This file was originally written by Colin Percival as part of the Tarsnap
 * online backup system.
 */

// Safe Rust translation of Verge Core crypto/pow/scrypt.cpp's fixed
// scrypt_1024_1_1_256 routine. Only public block headers are hashed here.
use bitcoin::hashes::{
    hmac::{Hmac, HmacEngine},
    sha256, Hash, HashEngine,
};
use std::cell::RefCell;

thread_local! {
    static SCRATCH: RefCell<Vec<[u32; 32]>> = RefCell::new(vec![[0; 32]; 1024]);
}

fn pbkdf2_once(key: &[u8], salt: &[u8], output: &mut [u8]) {
    for (index, chunk) in output.chunks_mut(32).enumerate() {
        let mut engine = HmacEngine::<sha256::Hash>::new(key);
        engine.input(salt);
        engine.input(&((index + 1) as u32).to_be_bytes());
        let hash = Hmac::<sha256::Hash>::from_engine(engine).to_byte_array();
        chunk.copy_from_slice(&hash[..chunk.len()]);
    }
}

fn quarter(x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
    x[b] ^= x[a].wrapping_add(x[d]).rotate_left(7);
    x[c] ^= x[b].wrapping_add(x[a]).rotate_left(9);
    x[d] ^= x[c].wrapping_add(x[b]).rotate_left(13);
    x[a] ^= x[d].wrapping_add(x[c]).rotate_left(18);
}

fn xor_salsa(x: &mut [u32; 32], left: usize, right: usize) {
    let mut work = [0; 16];
    for i in 0..16 {
        x[left + i] ^= x[right + i];
    }
    work.copy_from_slice(&x[left..left + 16]);
    for _ in 0..4 {
        quarter(&mut work, 0, 4, 8, 12);
        quarter(&mut work, 5, 9, 13, 1);
        quarter(&mut work, 10, 14, 2, 6);
        quarter(&mut work, 15, 3, 7, 11);
        quarter(&mut work, 0, 1, 2, 3);
        quarter(&mut work, 5, 6, 7, 4);
        quarter(&mut work, 10, 11, 8, 9);
        quarter(&mut work, 15, 12, 13, 14);
    }
    for i in 0..16 {
        x[left + i] = x[left + i].wrapping_add(work[i]);
    }
}

pub(crate) fn hash(header: &[u8]) -> [u8; 32] {
    let mut bytes = [0; 128];
    pbkdf2_once(header, header, &mut bytes);
    let mut x = [0; 32];
    for (word, chunk) in x.iter_mut().zip(bytes.chunks_exact(4)) {
        *word = u32::from_le_bytes(chunk.try_into().unwrap());
    }
    SCRATCH.with(|scratch| {
        let mut scratch = scratch.borrow_mut();
        for row in scratch.iter_mut() {
            *row = x;
            xor_salsa(&mut x, 0, 16);
            xor_salsa(&mut x, 16, 0);
        }
        for _ in 0..1024 {
            let row = &scratch[(x[16] & 1023) as usize];
            for i in 0..32 {
                x[i] ^= row[i];
            }
            xor_salsa(&mut x, 0, 16);
            xor_salsa(&mut x, 16, 0);
        }
    });
    for (word, chunk) in x.iter().zip(bytes.chunks_exact_mut(4)) {
        chunk.copy_from_slice(&word.to_le_bytes());
    }
    let mut output = [0; 32];
    pbkdf2_once(header, &bytes, &mut output);
    output
}
