// Modular index math for gallery navigation — wraps around both ends so that
// stepping past the last image lands on the first (and vice versa).
export const wrapIndex = (index: number, length: number, delta = 1): number => {
  if (length <= 0) return 0
  return (((index + delta) % length) + length) % length
}
