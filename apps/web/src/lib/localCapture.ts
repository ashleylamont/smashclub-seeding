/** Browser lifecycle reference: https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop
 * A cancelled permission prompt may resolve later. Never attach its orphaned stream. */
export class LocalCapture {
  private generation = 0;
  private stream: MediaStream | null = null;
  private ended: (() => void) | null = null;
  constructor(private readonly changed: (stream: MediaStream | null) => void) {}
  private release() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        if (this.ended) track.removeEventListener('ended', this.ended);
        track.stop();
      }
    }
    this.stream = null;
    this.ended = null;
  }
  async start(request: () => Promise<MediaStream>) {
    const attempt = ++this.generation;
    this.release();
    this.changed(null);
    // Invoke directly from the click handler to preserve browser user activation.
    const stream = await request();
    if (attempt !== this.generation) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    if (!stream.getVideoTracks().some(track => track.readyState === 'live')) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('The selected source has no live video. Choose another source.');
    }
    this.stream = stream;
    this.ended = () => this.stop();
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', this.ended, { once: true });
    this.changed(stream);
    return true;
  }
  stop() { ++this.generation; this.release(); this.changed(null); }
  dispose() { ++this.generation; this.release(); }
}
export function captureError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Capture was cancelled or permission was denied. Try again and allow the selected source.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'That camera or capture card is unavailable. Connect it, refresh the devices and choose again.';
  if (name === 'NotReadableError') return 'The source could not be opened. Close other apps using the camera or capture card, then retry.';
  return error instanceof Error ? error.message : 'Capture could not start in this browser. Use the OBS browser-source setup instead.';
}
