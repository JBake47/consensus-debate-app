import {
  buildAttachmentContentForModel,
  buildAttachmentRoutingOverview,
  buildAttachmentMessagesForModels,
} from './attachmentRouting.js';

function truncateContent(content, maxChars) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function buildTextAttachmentBlock(label, attachment) {
  if (attachment.content) {
    return `\n\n---\n**${label}: ${attachment.name}**\n\`\`\`\n${truncateContent(attachment.content, 50000)}\n\`\`\``;
  }
  return `\n\n---\n**${label}: ${attachment.name}**\n(Unable to extract text content from this file.)`;
}

export function buildAttachmentContent(text, attachments, options = {}) {
  return buildAttachmentContentForModel(text, attachments, options);
}

export function buildAttachmentTextContent(text, attachments, options = {}) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const videoUrls = Array.isArray(options.videoUrls)
    ? options.videoUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : [];

  if (safeAttachments.length === 0 && videoUrls.length === 0) {
    return text;
  }

  let nextText = String(text || '');
  const textAttachments = safeAttachments.filter((attachment) => attachment.category !== 'image');
  if (textAttachments.length > 0) {
    const attachmentText = textAttachments
      .map((attachment) => {
        return buildTextAttachmentBlock('Attached file', attachment);
      })
      .join('');
    nextText += attachmentText;
  }

  const imageAttachments = safeAttachments.filter((attachment) => attachment.category === 'image');
  const imageTextAttachments = imageAttachments.filter((attachment) => String(attachment?.content || '').trim());
  if (imageTextAttachments.length > 0) {
    nextText += imageTextAttachments
      .map((attachment) => buildTextAttachmentBlock('Attached image OCR text', attachment))
      .join('');
  }

  const rawImageAttachments = imageAttachments.filter((attachment) => !String(attachment?.content || '').trim());
  if (rawImageAttachments.length > 0) {
    const imageList = rawImageAttachments.map((attachment) => attachment.name).join(', ');
    nextText += `\n\n---\n**Attached images (not included inline):** ${imageList}`;
  }

  if (videoUrls.length > 0) {
    nextText += `\n\n---\n**Referenced videos:**\n${videoUrls.map((url) => `- ${url}`).join('\n')}`;
  }

  return nextText;
}

export {
  buildAttachmentMessagesForModels,
  buildAttachmentRoutingOverview,
};
