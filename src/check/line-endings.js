export function lineEndingSignature(buffer) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0x0d) {
      if (buffer[index + 1] === 0x0a) {
        crlf++;
        index++;
      } else {
        cr++;
      }
    } else if (buffer[index] === 0x0a) {
      lf++;
    }
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  const style = kinds > 1 ? 'mixed' : crlf > 0 ? 'CRLF' : lf > 0 ? 'LF' : cr > 0 ? 'CR' : 'none';
  return {
    style,
    finalNewline: buffer.length > 0 && (buffer.at(-1) === 0x0a || buffer.at(-1) === 0x0d),
    bom: buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
  };
}
