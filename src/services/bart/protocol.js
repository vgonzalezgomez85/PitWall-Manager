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
'use strict';

// ============================================================================
//  BART binary protocol  (Policar FL_BLE rev 0.04)
//  Frame:  A5 | MSG_TYPE | OP | payload... | CRC-8(poly 0x07, init 0x00)
//  All multi-byte numbers are little-endian.  CRC covers every byte but itself.
// ============================================================================

const SYNC = 0xA5;

// MSG_TYPE (byte 1) -- direction/category
const MSG = {
  LAP: 0x01,     // Slave -> Master -> Phone   (lap event)
  STATUS: 0x20,  // Any   -> Master/Phone      (status snapshot)
  FANOUT: 0x30,  // Master -> Slaves           (broadcast)
  ACK: 0x7F,     // Any   -> Any               (acknowledgement)
  CMD: 0x90,     // Phone -> Master            (command/config/control)
};

// OP_CODE (byte 2)
const OP = {
  START: 0x01,
  STOP: 0x02,
  PAUSE: 0x03,
  CLEAR: 0x04,
  SET_MINLAP: 0x10,
  READ_STAT: 0x20,
  NOTIFY: 0x30,       // payload 01 = enable, 00 = disable
  SET_MODE: 0x40,
  SET_ID: 0x41,
  SET_LABEL: 0x42,
  SET_MASTER: 0x43,
  READ_CONFIG: 0x50,
};

// Race state machine (4.1 / Appendix H)
const STATE = { FREE: 0, RUN: 1, PAUSE: 2, STOP: 3 };

// ---- CRC-8, polynomial 0x07, init 0x00 (Appendix G) -----------------------
function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
    }
  }
  return crc;
}

// Append the CRC byte over an array/buffer of body bytes -> sealed Buffer.
function seal(bytes) {
  const body = Buffer.from(bytes);
  return Buffer.concat([body, Buffer.from([crc8(body)])]);
}

// ---- Stream framing -------------------------------------------------------
// BART frames carry NO length byte. Over BLE each notification/write is one
// packet, so boundaries are implicit. Over a stream (TCP/serial) we must know
// the expected length from (MSG_TYPE, OP). These resolvers provide that.

// length of a Master->Phone notification given its MSG_TYPE
function notifyLength(msgType) {
  switch (msgType) {
    case MSG.LAP: return 14;   // hardware real Policar FL_BLE: 13 cuerpo + seq + CRC
    case MSG.ACK: return 5;
    case MSG.STATUS: return 12;
    default: return null;
  }
}

// Generic resync-capable frame parser. resolveLength(msgType, op) -> total|null
class FrameParser {
  constructor(resolveLength, onFrame, onError) {
    this.buf = Buffer.alloc(0);
    this.resolveLength = resolveLength;
    this.onFrame = onFrame;
    this.onError = onError || (() => {});
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this._drain();
  }
  _drain() {
    while (this.buf.length > 0) {
      if (this.buf[0] !== SYNC) {              // hunt for the next sync byte
        const idx = this.buf.indexOf(SYNC);
        if (idx === -1) { this.buf = Buffer.alloc(0); return; }
        this.buf = this.buf.slice(idx);
      }
      if (this.buf.length < 3) return;          // need MSG_TYPE + OP to size it
      const msgType = this.buf[1];
      const op = this.buf[2];
      const total = this.resolveLength(msgType, op);
      if (total == null) {                      // unknown framing -> resync
        this.onError({ type: 'unframable', msgType, op });
        this.buf = this.buf.slice(1);
        continue;
      }
      if (this.buf.length < total) return;      // wait for the rest
      const frame = this.buf.slice(0, total);
      const calc = crc8(frame.slice(0, total - 1));
      if (calc !== frame[total - 1]) {          // corrupt -> drop + resync
        this.onError({ type: 'crc', frame, expected: calc, got: frame[total - 1] });
        this.buf = this.buf.slice(1);
        continue;
      }
      this.buf = this.buf.slice(total);
      this.onFrame({ msgType, op, frame });
    }
  }
}

// pretty hex dump
function hex(buf) {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

module.exports = {
  SYNC, MSG, OP, STATE,
  crc8, seal, hex,
  notifyLength, FrameParser,
};
