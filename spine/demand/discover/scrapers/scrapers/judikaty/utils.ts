/** Generate year-based date ranges (DD.MM.YYYY) from current year down to startYear */
export const generateYearRanges = (startYear: number): Array<{ from: string; to: string; label: string }> => {
  const ranges: Array<{ from: string; to: string; label: string }> = [];
  const currentYear = new Date().getFullYear();
  for (let year = currentYear; year >= startYear; year--) {
    ranges.push({ from: `01.01.${year}`, to: `31.12.${year}`, label: `${year}` });
  }
  return ranges;
};
