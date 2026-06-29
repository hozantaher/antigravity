import { docxToPdf } from './pdf.js';

const mockExecFile = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);
const mockRm = vi.fn().mockResolvedValue(undefined);

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

describe('pdf', () => {
  const docxBuffer = Buffer.from('fake docx content');
  const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockReadFile.mockResolvedValue(pdfBuffer);
    mockStat.mockResolvedValue({ size: pdfBuffer.length });
  });

  it('returns PDF buffer on success', async () => {
    const result = await docxToPdf(docxBuffer);
    expect(result).toEqual(pdfBuffer);
  });

  it('writes DOCX to temp file before conversion', async () => {
    await docxToPdf(docxBuffer);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, data] = mockWriteFile.mock.calls[0];
    expect(path).toMatch(/\.docx$/);
    expect(data).toBe(docxBuffer);
  });

  it('calls libreoffice with headless and unique UserInstallation', async () => {
    await docxToPdf(docxBuffer);
    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toMatch(/libreoffice$/);
    expect(args).toContain('--headless');
    expect(args).toContain('--norestore');
    expect(args.find((a: string) => a.startsWith('-env:UserInstallation='))).toBeTruthy();
    expect(opts.timeout).toBe(30_000);
  });

  it('uses unique profile directory per invocation', async () => {
    await docxToPdf(docxBuffer);
    await docxToPdf(docxBuffer);
    const profile1 = mockExecFile.mock.calls[0][1].find((a: string) => a.startsWith('-env:'));
    const profile2 = mockExecFile.mock.calls[1][1].find((a: string) => a.startsWith('-env:'));
    expect(profile1).not.toBe(profile2);
  });

  it('validates PDF exists after conversion', async () => {
    mockStat.mockResolvedValue(null);
    await expect(docxToPdf(docxBuffer)).rejects.toThrow('LibreOffice failed to generate PDF');
  });

  it('throws when PDF is empty (0 bytes)', async () => {
    mockStat.mockResolvedValue({ size: 0 });
    await expect(docxToPdf(docxBuffer)).rejects.toThrow('LibreOffice failed to generate PDF');
  });

  it('throws when stat fails (file not found)', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));
    await expect(docxToPdf(docxBuffer)).rejects.toThrow('LibreOffice failed to generate PDF');
  });

  it('cleans up temp files on success', async () => {
    await docxToPdf(docxBuffer);
    expect(mockUnlink).toHaveBeenCalledTimes(2); // docx + pdf
    expect(mockRm).toHaveBeenCalledTimes(2); // profile dir + per-job tmp dir
  });

  it('cleans up temp files on error', async () => {
    mockExecFile.mockRejectedValue(new Error('libreoffice crashed'));
    await expect(docxToPdf(docxBuffer)).rejects.toThrow();
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockRm).toHaveBeenCalledTimes(2); // profile + per-job tmp
  });

  it('passes killSignal SIGKILL so a stuck soffice gets killed on timeout', async () => {
    await docxToPdf(docxBuffer);
    const [, , opts] = mockExecFile.mock.calls[0];
    expect(opts.killSignal).toBe('SIGKILL');
    expect(opts.timeout).toBe(30_000);
  });

  it('uses a per-invocation tmp subdirectory (isolates concurrent jobs)', async () => {
    await docxToPdf(docxBuffer);
    await docxToPdf(docxBuffer);

    const [path1] = mockWriteFile.mock.calls[0];
    const [path2] = mockWriteFile.mock.calls[1];
    // Parent dirs should differ per job — no shared tmp between invocations.
    const dir1 = path1.replace(/\/[^/]+\.docx$/, '');
    const dir2 = path2.replace(/\/[^/]+\.docx$/, '');
    expect(dir1).not.toBe(dir2);
    // Each parent dir is under a rozporuj- prefix (our isolation namespace).
    expect(dir1).toMatch(/rozporuj-/);
    expect(dir2).toMatch(/rozporuj-/);
  });

  it('invokes mkdir recursive on the per-job tmp dir before writing', async () => {
    await docxToPdf(docxBuffer);
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('rozporuj-'), { recursive: true });
  });
});
