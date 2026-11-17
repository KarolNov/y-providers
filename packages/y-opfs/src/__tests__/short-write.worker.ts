/// <reference lib="webworker" />
// The OPFS worker, with Firefox's over-quota behaviour: no file grows past
// `self.name` bytes, and a write that does not fit stores what fits and
// returns the shorter count instead of throwing.
import '../worker.js'

const limit = Number(self.name)
const write = FileSystemSyncAccessHandle.prototype.write
FileSystemSyncAccessHandle.prototype.write = function (buffer, options) {
  const data = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)
  const at = options?.at ?? 0
  return write.call(this, data.subarray(0, Math.max(0, limit - at)), options)
}
