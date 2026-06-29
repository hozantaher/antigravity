const mockSave = vi.fn().mockResolvedValue(undefined);
const mockDownload = vi.fn().mockResolvedValue([Buffer.from('file content')]);
const mockGetSignedUrl = vi.fn().mockResolvedValue(['https://storage.example.com/signed-url']);
const mockGetFiles = vi.fn().mockResolvedValue([[]]);
const mockExists = vi.fn().mockResolvedValue([false]);
const mockFile = vi.fn().mockReturnValue({
  save: mockSave,
  download: mockDownload,
  getSignedUrl: mockGetSignedUrl,
  exists: mockExists,
});
const mockBucket = vi.fn().mockReturnValue({
  file: mockFile,
  getFiles: mockGetFiles,
});
const mockGetStorage = vi.fn().mockReturnValue({ bucket: mockBucket });
const mockInitializeApp = vi.fn();
const mockCert = vi.fn().mockReturnValue('mock-credential');
const mockGetApps = vi.fn().mockReturnValue([]);

vi.mock('firebase-admin/app', () => ({
  initializeApp: (...args: unknown[]) => mockInitializeApp(...args),
  cert: (...args: unknown[]) => mockCert(...args),
  getApps: () => mockGetApps(),
}));

vi.mock('firebase-admin/storage', () => ({
  getStorage: () => mockGetStorage(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('{"project_id":"test"}'),
}));

describe('firebase', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetApps.mockReturnValue([]);
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = Buffer.from('{"project_id":"test"}').toString('base64');
    process.env.FIREBASE_STORAGE_BUCKET = 'test-bucket';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('downloadFiles', () => {
    it('returns array of uploaded files', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      const fileObj = {
        name: 'uploads/abc/file.pdf',
        download: vi.fn().mockResolvedValue([Buffer.from('pdf content')]),
        metadata: { contentType: 'application/pdf' },
      };
      mockGetFiles.mockResolvedValue([[fileObj]]);

      const { downloadFiles } = await import('./firebase.js');
      const files = await downloadFiles('abc');

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('uploads/abc/file.pdf');
      expect(files[0].contentType).toBe('application/pdf');
      expect(files[0].buffer).toEqual(Buffer.from('pdf content'));
    });

    it('returns empty array when no files', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      mockGetFiles.mockResolvedValue([[]]);

      const { downloadFiles } = await import('./firebase.js');
      const files = await downloadFiles('empty-session');
      expect(files).toHaveLength(0);
    });

    it('defaults contentType to application/octet-stream', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      const fileObj = {
        name: 'uploads/abc/file.bin',
        download: vi.fn().mockResolvedValue([Buffer.from('binary')]),
        metadata: {},
      };
      mockGetFiles.mockResolvedValue([[fileObj]]);

      const { downloadFiles } = await import('./firebase.js');
      const files = await downloadFiles('abc');
      expect(files[0].contentType).toBe('application/octet-stream');
    });
  });

  describe('uploadFile', () => {
    it('saves buffer and returns signed URL', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);

      const { uploadFile } = await import('./firebase.js');
      const url = await uploadFile('results/abc/odpor.pdf', Buffer.from('pdf'), 'application/pdf');

      expect(mockFile).toHaveBeenCalledWith('results/abc/odpor.pdf');
      expect(mockSave).toHaveBeenCalledWith(Buffer.from('pdf'), { metadata: { contentType: 'application/pdf' } });
      expect(mockGetSignedUrl).toHaveBeenCalled();
      expect(url).toBe('https://storage.example.com/signed-url');
    });
  });

  describe('uploadResults', () => {
    it('uploads both PDF and DOCX and returns all URLs', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);

      const { uploadResults } = await import('./firebase.js');
      const result = await uploadResults('abc', Buffer.from('pdf'), Buffer.from('docx'));

      expect(result.outputPath).toBe('results/abc/odpor.pdf');
      expect(result.downloadUrl).toBe('https://storage.example.com/signed-url');
      expect(result.docxUrl).toBe('https://storage.example.com/signed-url');
    });
  });

  describe('fileExists', () => {
    it('returns true when bucket.file(path).exists() reports true', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      mockExists.mockResolvedValue([true]);

      const { fileExists } = await import('./firebase.js');
      const exists = await fileExists('results/abc/odpor.pdf');
      expect(exists).toBe(true);
      expect(mockFile).toHaveBeenCalledWith('results/abc/odpor.pdf');
    });

    it('returns false when the bucket reports the file is missing', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      mockExists.mockResolvedValue([false]);

      const { fileExists } = await import('./firebase.js');
      const exists = await fileExists('results/missing/odpor.pdf');
      expect(exists).toBe(false);
    });
  });

  describe('getSignedUrl (existing-file variant)', () => {
    it('returns a fresh signed URL for a given storage path', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      mockGetSignedUrl.mockResolvedValue(['https://storage.example.com/fresh-url']);

      const { getSignedUrl } = await import('./firebase.js');
      const url = await getSignedUrl('results/abc/odpor.pdf');
      expect(url).toBe('https://storage.example.com/fresh-url');
      expect(mockFile).toHaveBeenCalledWith('results/abc/odpor.pdf');
    });
  });

  describe('downloadFileBuffer', () => {
    it('returns the buffer downloaded from the bucket', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing-app']);
      mockDownload.mockResolvedValue([Buffer.from('cached-pdf')]);

      const { downloadFileBuffer } = await import('./firebase.js');
      const buf = await downloadFileBuffer('results/abc/odpor.pdf');
      expect(buf).toEqual(Buffer.from('cached-pdf'));
    });
  });

  describe('ensureApp', () => {
    it('initializes with base64 service account', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue([]);

      const { downloadFiles } = await import('./firebase.js');
      await downloadFiles('trigger-init').catch(() => {});

      expect(mockInitializeApp).toHaveBeenCalledOnce();
      expect(mockCert).toHaveBeenCalledWith({ project_id: 'test' });
    });

    it('initializes with file path when base64 not set', async () => {
      vi.resetModules();
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = '/path/to/sa.json';
      mockGetApps.mockReturnValue([]);

      const { downloadFiles } = await import('./firebase.js');
      await downloadFiles('trigger-init').catch(() => {});

      expect(mockInitializeApp).toHaveBeenCalledOnce();
    });

    it('throws when neither env var is set', async () => {
      vi.resetModules();
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      mockGetApps.mockReturnValue([]);

      const { downloadFiles } = await import('./firebase.js');
      await expect(downloadFiles('abc')).rejects.toThrow('FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
    });

    it('skips initialization when app already exists', async () => {
      vi.resetModules();
      mockGetApps.mockReturnValue(['existing']);

      const { downloadFiles } = await import('./firebase.js');
      await downloadFiles('abc').catch(() => {});

      expect(mockInitializeApp).not.toHaveBeenCalled();
    });
  });
});
