/** Tiện ích số thuần dùng chung các engine của Module 8. */

/** Làm tròn 1 chữ số thập phân (điểm, phần trăm). */
export const R1 = (n: number): number => Math.round(n * 10) / 10;

/** Kẹp n vào đoạn [min, max]. */
export const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));
