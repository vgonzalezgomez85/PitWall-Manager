/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// Distribución de la CA raíz de PitWall. Instalarla en un dispositivo hace que
// el HTTPS local salga SIN el aviso de seguridad (la opción "CA" del control de
// pilotos). La CA es un certificado público (no lleva clave privada), así que
// esta descarga es segura de exponer en la LAN.
const TlsService = require('../services/TlsService');

class CertController {

  // GET /cert/ca — descarga el certificado de la CA (para instalar/confiar).
  // Extensión .crt: Windows/Android lo reconocen al abrirlo; iOS lo instala
  // como perfil. El navegador puede pedir abrir o guardar.
  static downloadCA(req, res) {
    try {
      const pem = TlsService.caCertPem();
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="PitWall-CA.crt"');
      res.send(pem);
    } catch (e) {
      res.status(500).send('No se pudo generar el certificado: ' + e.message);
    }
  }

  // GET /cert — página de instrucciones para instalar la CA en cada dispositivo.
  static instructions(req, res) {
    let fingerprint = null;
    try { fingerprint = TlsService.caFingerprint(); } catch {}
    res.render('cert/index', { t: req.t, fingerprint });
  }
}

module.exports = CertController;
