import { processFile } from '../lib/fileProcessor';

self.onmessage = async (event) => {
  const requestId = event.data?.requestId;
  const fileEntries = Array.isArray(event.data?.files) ? event.data.files : [];

  const results = await Promise.all(
    fileEntries.map(async (entry) => {
      const file = entry?.file || entry;
      const uploadId = entry?.uploadId || null;
      try {
        return {
          uploadId,
          attachment: {
            ...(await processFile(file)),
            uploadId,
          },
        };
      } catch {
        return {
          uploadId,
          attachment: {
            uploadId,
            name: file?.name || 'attachment',
            size: Number(file?.size || 0),
            type: file?.type || '',
            category: 'error',
            content: '',
            preview: 'error',
            error: 'Failed to process file',
            processingStatus: 'error',
          },
        };
      }
    })
  );

  self.postMessage({ requestId, results });
};
