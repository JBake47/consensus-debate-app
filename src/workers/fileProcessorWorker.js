import { processFile } from '../lib/fileProcessor';

self.onmessage = async (event) => {
  const requestId = event.data?.requestId;
  const files = Array.isArray(event.data?.files) ? event.data.files : [];

  const results = await Promise.all(
    files.map(async (file) => {
      try {
        return { attachment: await processFile(file) };
      } catch {
        return {
          attachment: {
            name: file?.name || 'attachment',
            size: Number(file?.size || 0),
            type: file?.type || '',
            category: 'error',
            content: '',
            preview: 'error',
            error: 'Failed to process file',
          },
        };
      }
    })
  );

  self.postMessage({ requestId, results });
};
