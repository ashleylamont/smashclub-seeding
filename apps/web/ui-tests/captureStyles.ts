import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const footerMetadataCapturePath = fileURLToPath(
  new URL('./footer-metadata-capture.css', import.meta.url),
);

export const footerMetadataCaptureStyle = readFileSync(footerMetadataCapturePath, 'utf8');
