// Node-only fast path used by shared codecs in the regression harness. No Node
// runtime or globals are bundled into the extension.
declare const Buffer: {
  from(value: string | Uint8Array, encoding?: 'base64'): Uint8Array & { toString(encoding: 'base64' | 'utf8'): string };
};
interface Window {
  __futureContextPalette?: { destroy(): void; openFromShortcut(): unknown; getShadow(): ShadowRoot };
}
