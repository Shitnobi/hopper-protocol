//! Sprite container: a 16×16 RGBA8 image with no external dependencies.
//!
//! The layout (row-major, 4 bytes per pixel, RGBA) is identical to
//! `image::RgbaImage`'s raw buffer, so downstream crates (indexer art
//! endpoints, wallet textures) convert with zero copies.

pub const SPRITE_W: usize = 16;
pub const SPRITE_H: usize = 16;
pub const SPRITE_RGBA_LEN: usize = SPRITE_W * SPRITE_H * 4;

/// A 16×16 RGBA sprite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sprite {
    pub data: [u8; SPRITE_RGBA_LEN],
}

impl Default for Sprite {
    fn default() -> Self {
        Sprite {
            data: [0; SPRITE_RGBA_LEN],
        }
    }
}

impl Sprite {
    pub fn transparent() -> Self {
        Self::default()
    }

    #[inline]
    pub fn px(&self, x: usize, y: usize) -> [u8; 4] {
        let i = (y * SPRITE_W + x) * 4;
        [
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, c: [u8; 4]) {
        let i = (y * SPRITE_W + x) * 4;
        self.data[i..i + 4].copy_from_slice(&c);
    }

    pub fn as_rgba(&self) -> &[u8] {
        &self.data
    }
}
