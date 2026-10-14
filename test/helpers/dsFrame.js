// Cierra una trama DS de prueba como lo haría la caja: 0xEB al final y checksum
// en byte[18] = (byte[1] + … + byte[17] + byte[19]) & 0xFF. El lector descarta las
// tramas con el checksum mal, así que una trama inventada sin sellar no llega.
function sellar(f) {
  if (f.length !== 21) return f;
  f[20] = 0xeb;
  let sum = f[19];
  for (let i = 1; i <= 17; i++) sum += f[i];
  f[18] = sum & 0xff;
  return f;
}

module.exports = { sellar };
