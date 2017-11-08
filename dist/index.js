'use strict';

function asPacketParserAPI(packet_impl_methods) {
  const {
    parseHeader,
    packMessage,
    asBuffer,
    concatBuffers,
    unpackId } = packet_impl_methods;

  const msg_obj_proto = {
    sliceBody() {
      return this._raw_.slice(this.body_offset);
    },
    sliceHeader() {
      return this._raw_.slice(this.header_offset, this.body_offset);
    },
    unpackId(buf, offset = 8) {
      return unpackId(buf || this._raw_, offset);
    } };

  const packetParserAPI = Object.assign(Object.create(null), packet_impl_methods, {
    packMessageObj,
    packetStream,
    asMsgObj,
    msg_obj_proto });
  return packetParserAPI;

  function packMessageObj(...args) {
    const msg_raw = packMessage(...args);
    const msg_obj = asMsgObj(parseHeader(msg_raw));
    Object.defineProperties(msg_obj, {
      _raw_: { value: msg_raw } });
    return msg_obj;
  }

  function asMsgObj({ info, pkt_header_len, packet_len, header_len, _raw_ }) {
    let body_offset = pkt_header_len + header_len;
    if (body_offset > packet_len) {
      body_offset = null; // invalid message construction
    }const msg_obj = Object.create(msg_obj_proto, {
      header_offset: { value: pkt_header_len },
      body_offset: { value: body_offset },
      packet_len: { value: packet_len },
      _raw_: { value: _raw_ } });

    return Object.assign(msg_obj, info);
  }

  function packetStream(options) {
    if (!options) {
      options = {};
    }

    const decrement_ttl = null == options.decrement_ttl ? true : !!options.decrement_ttl;

    let tip = null,
        qByteLen = 0,
        q = [];
    return feed;

    function feed(data, complete = []) {
      data = asBuffer(data);
      q.push(data);
      qByteLen += data.byteLength;

      while (1) {
        const msg = parseTipMessage();
        if (undefined !== msg) {
          complete.push(msg);
        } else return complete;
      }
    }

    function parseTipMessage() {
      if (null === tip) {
        if (0 === q.length) {
          return;
        }
        if (1 < q.length) {
          q = [concatBuffers(q, qByteLen)];
        }

        tip = parseHeader(q[0], decrement_ttl);
        if (null === tip) {
          return;
        }
      }

      const len = tip.packet_len;
      if (qByteLen < len) {
        return;
      }

      let bytes = 0,
          n = 0;
      while (bytes < len) {
        bytes += q[n++].byteLength;
      }

      const trailingBytes = bytes - len;
      if (0 === trailingBytes) {
        // we have an exact length match
        const parts = q.splice(0, n);
        qByteLen -= len;

        tip._raw_ = concatBuffers(parts, len);
      } else {
        // we have trailing bytes on the last array
        const parts = 1 === q.length ? [] : q.splice(0, n - 1);
        const tail = q[0];

        parts.push(tail.slice(0, -trailingBytes));
        q[0] = tail.slice(-trailingBytes);
        qByteLen -= len;

        tip._raw_ = concatBuffers(parts, len);
      }

      {
        const msg_obj = asMsgObj(tip);
        tip = null;
        return msg_obj;
      }
    }
  }
}

/*
  0123456789ab     -- 12-byte packet header (control)
  0123456789abcdef -- 16-byte packet header (routing)
  
  01.............. -- uint16 signature = 0xFE 0xED
  ..23 ........... -- uint16 packet length

  ....4........... -- uint8 ttl hops

  .....5.......... -- uint8 header type
  ......67........ -- uint8 header length

  ........89ab.... -- uint32 id_router
                      4-byte random space allows 1 million nodes with
                      0.02% chance of two nodes selecting the same id

  ............cdef -- uint32 id_target (when id_router !== 0)
                      4-byte random space allows 1 million nodes with
                      0.02% chance of two nodes selecting the same id
 */

const signature = 0xedfe;
const pkt_control_header_size = 12;
const pkt_routing_header_size = 16;
const default_ttl = 31;

function createBufferPacketParser(options = {}) {
  return asPacketParserAPI({
    parseHeader, packMessage,
    packId, unpackId, pack_utf8, unpack_utf8,

    asBuffer, concatBuffers });

  function parseHeader(buf, decrement_ttl) {
    const sig = buf.readUInt16LE(0);
    if (signature !== sig) {
      throw new Error(`Packet stream framing error (found: ${sig.toString(16)} expected: ${signature.toString(16)})`);
    }

    // up to 64k packet length; length includes header
    const packet_len = buf.readUInt16LE(2);
    let header_len = buf.readUInt16LE(4);
    const type = buf.readUInt8(6);

    let ttl = buf.readUInt8(7);
    if (decrement_ttl) {
      ttl = Math.max(0, ttl - 1);
      buf.writeUInt8(ttl, 7);
    }

    const id_router = buf.readUInt32LE(8);
    const info = { type, ttl, id_router };

    if (0 === id_router) {
      return { info, packet_len, header_len, pkt_header_len: pkt_control_header_size };
    } else if (pkt_routing_header_size > buf.byteLength) {
      return null; // this buffer is fragmented before id_target
    } else {
        info.id_target = buf.readUInt32LE(12);
        return { info, packet_len, header_len, pkt_header_len: pkt_routing_header_size };
      }
  }

  function packMessage(...args) {
    let { type, ttl, id_router, id_target, header, body } = Object.assign({}, ...args);
    header = asBuffer(header);
    body = asBuffer(body);

    const pkt_header_size = id_router ? pkt_routing_header_size : pkt_control_header_size;
    const packet_len = pkt_header_size + header.byteLength + body.byteLength;
    if (packet_len > 0xffff) {
      throw new Error(`Packet too large`);
    }

    const pkt = Buffer.alloc(pkt_header_size);
    pkt.writeUInt16LE(signature, 0);
    pkt.writeUInt16LE(packet_len, 2);
    pkt.writeUInt16LE(header.byteLength, 4);
    pkt.writeUInt8(type || 0, 6);
    pkt.writeUInt8(ttl || default_ttl, 7);
    if (!id_router) {
      pkt.writeUInt32LE(0, 8);
      if (id_target) {
        throw new Error(`Invalid id_target for control packet`);
      }
    } else {
      pkt.writeUInt32LE(id_router, 8);
      pkt.writeUInt32LE(id_target || 0, 12);
    }

    const buf = Buffer.concat([pkt, header, body]);
    if (packet_len !== buf.byteLength) {
      throw new Error(`Packed message length mismatch (library error)`);
    }
    return buf;
  }

  function packId(id, offset) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(id, offset);
    return buf;
  }
  function unpackId(buf, offset) {
    return buf.readUInt32LE(offset);
  }

  function pack_utf8(str) {
    return Buffer.from(str, 'utf-8');
  }
  function unpack_utf8(buf) {
    return asBuffer(buf).toString('utf-8');
  }

  function asBuffer(buf) {
    if (null === buf || undefined === buf) {
      return Buffer(0);
    }

    if (Buffer.isBuffer(buf)) {
      return buf;
    }

    if ('string' === typeof buf) {
      return pack_utf8(buf);
    }

    if (undefined !== buf.byteLength) {
      return Buffer.from(buf); // TypedArray or ArrayBuffer
    }if (Array.isArray(buf)) {
      if (Number.isSafeInteger(buf[0])) {
        return Buffer.from(buf);
      }
      return Buffer.concat(buf.map(asBuffer));
    }
  }

  function concatBuffers(lst, len) {
    if (1 === lst.length) {
      return lst[0];
    }
    if (0 === lst.length) {
      return Buffer(0);
    }
    return Buffer.concat(lst);
  }
}

/*
  0123456789ab     -- 12-byte packet header (control)
  0123456789abcdef -- 16-byte packet header (routing)
  
  01.............. -- uint16 signature = 0xFE 0xED
  ..23 ........... -- uint16 packet length

  ....4........... -- uint8 ttl hops

  .....5.......... -- uint8 header type
  ......67........ -- uint8 header length

  ........89ab.... -- uint32 id_router
                      4-byte random space allows 1 million nodes with
                      0.02% chance of two nodes selecting the same id

  ............cdef -- uint32 id_target (when id_router !== 0)
                      4-byte random space allows 1 million nodes with
                      0.02% chance of two nodes selecting the same id
 */

const signature$1 = 0xedfe;
const pkt_control_header_size$1 = 12;
const pkt_routing_header_size$1 = 16;
const default_ttl$1 = 31;

const little_endian = true;

function createDataViewPacketParser(options = {}) {
  const _TextEncoder_ = options.TextEncoder || TextEncoder;
  const _TextDecoder_ = options.TextDecoder || TextDecoder;

  return asPacketParserAPI({
    parseHeader, packMessage,
    packId, unpackId, pack_utf8, unpack_utf8,

    asBuffer, concatBuffers });

  function parseHeader(buf, decrement_ttl) {
    const dv = new DataView(buf);

    const sig = dv.getUint16(0, little_endian);
    if (signature$1 !== sig) {
      throw new Error(`Packet stream framing error (found: ${sig.toString(16)} expected: ${signature$1.toString(16)})`);
    }

    // up to 64k packet length; length includes header
    const packet_len = dv.getUint16(2, little_endian);
    let header_len = dv.getUint16(4, little_endian);
    const type = dv.getUint8(6, little_endian);

    let ttl = dv.getUint8(7, little_endian);
    if (decrement_ttl) {
      ttl = Math.max(0, ttl - 1);
      dv.setUint8(7, ttl, little_endian);
    }

    const id_router = dv.getUint32(8, little_endian);
    const info = { type, ttl, id_router };

    if (0 === id_router) {
      return { info, packet_len, header_len, pkt_header_len: pkt_control_header_size$1 };
    } else if (pkt_routing_header_size$1 > buf.byteLength) {
      return null; // this buffer is fragmented before id_target
    } else {
        info.id_target = dv.getUint32(12, little_endian);
        return { info, packet_len, header_len, pkt_header_len: pkt_routing_header_size$1 };
      }
  }

  function packMessage(...args) {
    let { type, ttl, id_router, id_target, header, body } = Object.assign({}, ...args);
    header = asBuffer(header, 'header');
    body = asBuffer(body, 'body');

    const pkt_header_size = id_router ? pkt_routing_header_size$1 : pkt_control_header_size$1;
    const len = pkt_header_size + header.byteLength + body.byteLength;
    if (len > 0xffff) {
      throw new Error(`Packet too large`);
    }

    const array = new ArrayBuffer(len);

    const dv = new DataView(array, 0, pkt_header_size);
    dv.setUint16(0, signature$1, little_endian);
    dv.setUint16(2, len, little_endian);
    dv.setUint16(4, header.byteLength, little_endian);
    dv.setUint8(6, type || 0, little_endian);
    dv.setUint8(7, ttl || default_ttl$1, little_endian);
    if (!id_router) {
      dv.setUint32(8, 0, little_endian);
      if (id_target) {
        throw new Error(`Invalid id_target for control packet`);
      }
    } else {
      dv.setUint32(8, id_router, little_endian);
      dv.setUint32(12, id_target || 0, little_endian);
    }

    const u8 = new Uint8Array(array);
    u8.set(new Uint8Array(header), pkt_header_size);
    u8.set(new Uint8Array(body), pkt_header_size + header.byteLength);
    return array;
  }

  function packId(id, offset) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(offset || 0, id, little_endian);
    return buf;
  }
  function unpackId(buf, offset) {
    const dv = new DataView(asBuffer(buf));
    return dv.getUint32(offset || 0, little_endian);
  }

  function pack_utf8(str) {
    const te = new _TextEncoder_('utf-8');
    return te.encode(str.toString()).buffer;
  }
  function unpack_utf8(buf) {
    const td = new _TextDecoder_('utf-8');
    return td.decode(asBuffer(buf));
  }

  function asBuffer(buf) {
    if (null === buf || undefined === buf) {
      return new ArrayBuffer(0);
    }

    if (undefined !== buf.byteLength) {
      if (undefined === buf.buffer) {
        return buf;
      }

      if (ArrayBuffer.isView(buf)) {
        return buf.buffer;
      }

      if ('function' === typeof buf.readUInt32LE) {
        return Uint8Array.from(buf).buffer; // NodeJS Buffer
      }return buf;
    }

    if ('string' === typeof buf) {
      return pack_utf8(buf);
    }

    if (Array.isArray(buf)) {
      if (Number.isSafeInteger(buf[0])) {
        return Uint8Array.from(buf).buffer;
      }
      return concat(buf.map(asBuffer));
    }
  }

  function concatBuffers(lst, len) {
    if (1 === lst.length) {
      return lst[0];
    }
    if (0 === lst.length) {
      return new ArrayBuffer(0);
    }

    if (null == len) {
      len = 0;
      for (const arr of lst) {
        len += arr.byteLength;
      }
    }

    const u8 = new Uint8Array(len);
    let offset = 0;
    for (const arr of lst) {
      u8.set(new Uint8Array(arr), offset);
      offset += arr.byteLength;
    }
    return u8.buffer;
  }
}

function createPacketParser(...args) {
  return createBufferPacketParser(...args);
}

Object.assign(createPacketParser, {
  asPacketParserAPI,
  createBufferPacketParser,
  createDataViewPacketParser });

module.exports = createPacketParser;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VzIjpbIi4uL2NvZGUvYmFzaWMuanMiLCIuLi9jb2RlL2J1ZmZlci5qcyIsIi4uL2NvZGUvZGF0YXZpZXcuanMiLCIuLi9jb2RlL2luZGV4LmNqcy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJcbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIGFzUGFja2V0UGFyc2VyQVBJKHBhY2tldF9pbXBsX21ldGhvZHMpIDo6XG4gIGNvbnN0IEB7fVxuICAgIHBhcnNlSGVhZGVyXG4gICAgcGFja01lc3NhZ2VcbiAgICBhc0J1ZmZlclxuICAgIGNvbmNhdEJ1ZmZlcnNcbiAgICB1bnBhY2tJZFxuICA9IHBhY2tldF9pbXBsX21ldGhvZHNcblxuICBjb25zdCBtc2dfb2JqX3Byb3RvID0gQDpcbiAgICBzbGljZUJvZHkoKSA6OiByZXR1cm4gdGhpcy5fcmF3Xy5zbGljZSBAIHRoaXMuYm9keV9vZmZzZXRcbiAgICBzbGljZUhlYWRlcigpIDo6IHJldHVybiB0aGlzLl9yYXdfLnNsaWNlIEAgdGhpcy5oZWFkZXJfb2Zmc2V0LCB0aGlzLmJvZHlfb2Zmc2V0XG4gICAgdW5wYWNrSWQoYnVmLCBvZmZzZXQ9OCkgOjogcmV0dXJuIHVucGFja0lkKGJ1ZiB8fCB0aGlzLl9yYXdfLCBvZmZzZXQpXG5cbiAgY29uc3QgcGFja2V0UGFyc2VyQVBJID0gT2JqZWN0LmFzc2lnbiBAXG4gICAgT2JqZWN0LmNyZWF0ZShudWxsKVxuICAgIHBhY2tldF9pbXBsX21ldGhvZHNcbiAgICBAe31cbiAgICAgIHBhY2tNZXNzYWdlT2JqXG4gICAgICBwYWNrZXRTdHJlYW1cbiAgICAgIGFzTXNnT2JqXG4gICAgICBtc2dfb2JqX3Byb3RvXG4gIHJldHVybiBwYWNrZXRQYXJzZXJBUElcblxuXG4gIGZ1bmN0aW9uIHBhY2tNZXNzYWdlT2JqKC4uLmFyZ3MpIDo6XG4gICAgY29uc3QgbXNnX3JhdyA9IHBhY2tNZXNzYWdlIEAgLi4uYXJnc1xuICAgIGNvbnN0IG1zZ19vYmogPSBhc01zZ09iaiBAIHBhcnNlSGVhZGVyIEAgbXNnX3Jhd1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0aWVzIEAgbXNnX29iaiwgQDpcbiAgICAgIF9yYXdfOiBAe30gdmFsdWU6IG1zZ19yYXdcbiAgICByZXR1cm4gbXNnX29ialxuXG5cbiAgZnVuY3Rpb24gYXNNc2dPYmooe2luZm8sIHBrdF9oZWFkZXJfbGVuLCBwYWNrZXRfbGVuLCBoZWFkZXJfbGVuLCBfcmF3X30pIDo6XG4gICAgbGV0IGJvZHlfb2Zmc2V0ID0gcGt0X2hlYWRlcl9sZW4gKyBoZWFkZXJfbGVuXG4gICAgaWYgYm9keV9vZmZzZXQgPiBwYWNrZXRfbGVuIDo6XG4gICAgICBib2R5X29mZnNldCA9IG51bGwgLy8gaW52YWxpZCBtZXNzYWdlIGNvbnN0cnVjdGlvblxuXG4gICAgY29uc3QgbXNnX29iaiA9IE9iamVjdC5jcmVhdGUgQCBtc2dfb2JqX3Byb3RvLCBAOlxuICAgICAgaGVhZGVyX29mZnNldDogQHt9IHZhbHVlOiBwa3RfaGVhZGVyX2xlblxuICAgICAgYm9keV9vZmZzZXQ6IEB7fSB2YWx1ZTogYm9keV9vZmZzZXRcbiAgICAgIHBhY2tldF9sZW46IEB7fSB2YWx1ZTogcGFja2V0X2xlblxuICAgICAgX3Jhd186IEB7fSB2YWx1ZTogX3Jhd19cblxuICAgIHJldHVybiBPYmplY3QuYXNzaWduIEAgbXNnX29iaiwgaW5mb1xuXG5cbiAgZnVuY3Rpb24gcGFja2V0U3RyZWFtKG9wdGlvbnMpIDo6XG4gICAgaWYgISBvcHRpb25zIDo6IG9wdGlvbnMgPSB7fVxuXG4gICAgY29uc3QgZGVjcmVtZW50X3R0bCA9XG4gICAgICBudWxsID09IG9wdGlvbnMuZGVjcmVtZW50X3R0bFxuICAgICAgICA/IHRydWUgOiAhISBvcHRpb25zLmRlY3JlbWVudF90dGxcblxuICAgIGxldCB0aXA9bnVsbCwgcUJ5dGVMZW4gPSAwLCBxID0gW11cbiAgICByZXR1cm4gZmVlZFxuXG4gICAgZnVuY3Rpb24gZmVlZChkYXRhLCBjb21wbGV0ZT1bXSkgOjpcbiAgICAgIGRhdGEgPSBhc0J1ZmZlcihkYXRhKVxuICAgICAgcS5wdXNoIEAgZGF0YVxuICAgICAgcUJ5dGVMZW4gKz0gZGF0YS5ieXRlTGVuZ3RoXG5cbiAgICAgIHdoaWxlIDEgOjpcbiAgICAgICAgY29uc3QgbXNnID0gcGFyc2VUaXBNZXNzYWdlKClcbiAgICAgICAgaWYgdW5kZWZpbmVkICE9PSBtc2cgOjpcbiAgICAgICAgICBjb21wbGV0ZS5wdXNoIEAgbXNnXG4gICAgICAgIGVsc2UgcmV0dXJuIGNvbXBsZXRlXG5cblxuICAgIGZ1bmN0aW9uIHBhcnNlVGlwTWVzc2FnZSgpIDo6XG4gICAgICBpZiBudWxsID09PSB0aXAgOjpcbiAgICAgICAgaWYgMCA9PT0gcS5sZW5ndGggOjpcbiAgICAgICAgICByZXR1cm5cbiAgICAgICAgaWYgMSA8IHEubGVuZ3RoIDo6XG4gICAgICAgICAgcSA9IEBbXSBjb25jYXRCdWZmZXJzIEAgcSwgcUJ5dGVMZW5cblxuICAgICAgICB0aXAgPSBwYXJzZUhlYWRlciBAIHFbMF0sIGRlY3JlbWVudF90dGxcbiAgICAgICAgaWYgbnVsbCA9PT0gdGlwIDo6IHJldHVyblxuXG4gICAgICBjb25zdCBsZW4gPSB0aXAucGFja2V0X2xlblxuICAgICAgaWYgcUJ5dGVMZW4gPCBsZW4gOjpcbiAgICAgICAgcmV0dXJuXG5cbiAgICAgIGxldCBieXRlcyA9IDAsIG4gPSAwXG4gICAgICB3aGlsZSBieXRlcyA8IGxlbiA6OlxuICAgICAgICBieXRlcyArPSBxW24rK10uYnl0ZUxlbmd0aFxuXG4gICAgICBjb25zdCB0cmFpbGluZ0J5dGVzID0gYnl0ZXMgLSBsZW5cbiAgICAgIGlmIDAgPT09IHRyYWlsaW5nQnl0ZXMgOjogLy8gd2UgaGF2ZSBhbiBleGFjdCBsZW5ndGggbWF0Y2hcbiAgICAgICAgY29uc3QgcGFydHMgPSBxLnNwbGljZSgwLCBuKVxuICAgICAgICBxQnl0ZUxlbiAtPSBsZW5cblxuICAgICAgICB0aXAuX3Jhd18gPSBjb25jYXRCdWZmZXJzIEAgcGFydHMsIGxlblxuXG4gICAgICBlbHNlIDo6IC8vIHdlIGhhdmUgdHJhaWxpbmcgYnl0ZXMgb24gdGhlIGxhc3QgYXJyYXlcbiAgICAgICAgY29uc3QgcGFydHMgPSAxID09PSBxLmxlbmd0aCA/IFtdIDogcS5zcGxpY2UoMCwgbi0xKVxuICAgICAgICBjb25zdCB0YWlsID0gcVswXVxuXG4gICAgICAgIHBhcnRzLnB1c2ggQCB0YWlsLnNsaWNlKDAsIC10cmFpbGluZ0J5dGVzKVxuICAgICAgICBxWzBdID0gdGFpbC5zbGljZSgtdHJhaWxpbmdCeXRlcylcbiAgICAgICAgcUJ5dGVMZW4gLT0gbGVuXG5cbiAgICAgICAgdGlwLl9yYXdfID0gY29uY2F0QnVmZmVycyBAIHBhcnRzLCBsZW5cblxuICAgICAgOjpcbiAgICAgICAgY29uc3QgbXNnX29iaiA9IGFzTXNnT2JqKHRpcClcbiAgICAgICAgdGlwID0gbnVsbFxuICAgICAgICByZXR1cm4gbXNnX29ialxuXG4iLCIvKlxuICAwMTIzNDU2Nzg5YWIgICAgIC0tIDEyLWJ5dGUgcGFja2V0IGhlYWRlciAoY29udHJvbClcbiAgMDEyMzQ1Njc4OWFiY2RlZiAtLSAxNi1ieXRlIHBhY2tldCBoZWFkZXIgKHJvdXRpbmcpXG4gIFxuICAwMS4uLi4uLi4uLi4uLi4uIC0tIHVpbnQxNiBzaWduYXR1cmUgPSAweEZFIDB4RURcbiAgLi4yMyAuLi4uLi4uLi4uLiAtLSB1aW50MTYgcGFja2V0IGxlbmd0aFxuXG4gIC4uLi40Li4uLi4uLi4uLi4gLS0gdWludDggdHRsIGhvcHNcblxuICAuLi4uLjUuLi4uLi4uLi4uIC0tIHVpbnQ4IGhlYWRlciB0eXBlXG4gIC4uLi4uLjY3Li4uLi4uLi4gLS0gdWludDggaGVhZGVyIGxlbmd0aFxuXG4gIC4uLi4uLi4uODlhYi4uLi4gLS0gdWludDMyIGlkX3JvdXRlclxuICAgICAgICAgICAgICAgICAgICAgIDQtYnl0ZSByYW5kb20gc3BhY2UgYWxsb3dzIDEgbWlsbGlvbiBub2RlcyB3aXRoXG4gICAgICAgICAgICAgICAgICAgICAgMC4wMiUgY2hhbmNlIG9mIHR3byBub2RlcyBzZWxlY3RpbmcgdGhlIHNhbWUgaWRcblxuICAuLi4uLi4uLi4uLi5jZGVmIC0tIHVpbnQzMiBpZF90YXJnZXQgKHdoZW4gaWRfcm91dGVyICE9PSAwKVxuICAgICAgICAgICAgICAgICAgICAgIDQtYnl0ZSByYW5kb20gc3BhY2UgYWxsb3dzIDEgbWlsbGlvbiBub2RlcyB3aXRoXG4gICAgICAgICAgICAgICAgICAgICAgMC4wMiUgY2hhbmNlIG9mIHR3byBub2RlcyBzZWxlY3RpbmcgdGhlIHNhbWUgaWRcbiAqL1xuXG5pbXBvcnQgYXNQYWNrZXRQYXJzZXJBUEkgZnJvbSAnLi9iYXNpYydcblxuY29uc3Qgc2lnbmF0dXJlID0gMHhlZGZlXG5jb25zdCBwa3RfY29udHJvbF9oZWFkZXJfc2l6ZSA9IDEyXG5jb25zdCBwa3Rfcm91dGluZ19oZWFkZXJfc2l6ZSA9IDE2XG5jb25zdCBkZWZhdWx0X3R0bCA9IDMxXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIGNyZWF0ZUJ1ZmZlclBhY2tldFBhcnNlcihvcHRpb25zPXt9KSA6OlxuICByZXR1cm4gYXNQYWNrZXRQYXJzZXJBUEkgQDpcbiAgICBwYXJzZUhlYWRlciwgcGFja01lc3NhZ2VcbiAgICBwYWNrSWQsIHVucGFja0lkLCBwYWNrX3V0ZjgsIHVucGFja191dGY4XG5cbiAgICBhc0J1ZmZlciwgY29uY2F0QnVmZmVyc1xuXG5cbiAgZnVuY3Rpb24gcGFyc2VIZWFkZXIoYnVmLCBkZWNyZW1lbnRfdHRsKSA6OlxuICAgIGNvbnN0IHNpZyA9IGJ1Zi5yZWFkVUludDE2TEUgQCAwXG4gICAgaWYgc2lnbmF0dXJlICE9PSBzaWcgOjpcbiAgICAgIHRocm93IG5ldyBFcnJvciBAIGBQYWNrZXQgc3RyZWFtIGZyYW1pbmcgZXJyb3IgKGZvdW5kOiAke3NpZy50b1N0cmluZygxNil9IGV4cGVjdGVkOiAke3NpZ25hdHVyZS50b1N0cmluZygxNil9KWBcblxuICAgIC8vIHVwIHRvIDY0ayBwYWNrZXQgbGVuZ3RoOyBsZW5ndGggaW5jbHVkZXMgaGVhZGVyXG4gICAgY29uc3QgcGFja2V0X2xlbiA9IGJ1Zi5yZWFkVUludDE2TEUgQCAyXG4gICAgbGV0IGhlYWRlcl9sZW4gPSBidWYucmVhZFVJbnQxNkxFIEAgNFxuICAgIGNvbnN0IHR5cGUgPSBidWYucmVhZFVJbnQ4IEAgNlxuXG4gICAgbGV0IHR0bCA9IGJ1Zi5yZWFkVUludDggQCA3XG4gICAgaWYgZGVjcmVtZW50X3R0bCA6OlxuICAgICAgdHRsID0gTWF0aC5tYXggQCAwLCB0dGwgLSAxXG4gICAgICBidWYud3JpdGVVSW50OCBAIHR0bCwgN1xuXG4gICAgY29uc3QgaWRfcm91dGVyID0gYnVmLnJlYWRVSW50MzJMRSBAIDhcbiAgICBjb25zdCBpbmZvID0gQHt9IHR5cGUsIHR0bCwgaWRfcm91dGVyXG5cbiAgICBpZiAwID09PSBpZF9yb3V0ZXIgOjpcbiAgICAgIHJldHVybiBAOiBpbmZvLCBwYWNrZXRfbGVuLCBoZWFkZXJfbGVuLCBwa3RfaGVhZGVyX2xlbjogcGt0X2NvbnRyb2xfaGVhZGVyX3NpemVcbiAgICBlbHNlIGlmIHBrdF9yb3V0aW5nX2hlYWRlcl9zaXplID4gYnVmLmJ5dGVMZW5ndGggOjpcbiAgICAgIHJldHVybiBudWxsIC8vIHRoaXMgYnVmZmVyIGlzIGZyYWdtZW50ZWQgYmVmb3JlIGlkX3RhcmdldFxuICAgIGVsc2UgOjpcbiAgICAgIGluZm8uaWRfdGFyZ2V0ID0gYnVmLnJlYWRVSW50MzJMRSBAIDEyXG4gICAgICByZXR1cm4gQDogaW5mbywgcGFja2V0X2xlbiwgaGVhZGVyX2xlbiwgcGt0X2hlYWRlcl9sZW46IHBrdF9yb3V0aW5nX2hlYWRlcl9zaXplXG5cblxuICBmdW5jdGlvbiBwYWNrTWVzc2FnZSguLi5hcmdzKSA6OlxuICAgIGxldCB7dHlwZSwgdHRsLCBpZF9yb3V0ZXIsIGlkX3RhcmdldCwgaGVhZGVyLCBib2R5fSA9IE9iamVjdC5hc3NpZ24gQCB7fSwgLi4uYXJnc1xuICAgIGhlYWRlciA9IGFzQnVmZmVyKGhlYWRlcilcbiAgICBib2R5ID0gYXNCdWZmZXIoYm9keSlcblxuICAgIGNvbnN0IHBrdF9oZWFkZXJfc2l6ZSA9IGlkX3JvdXRlclxuICAgICAgPyBwa3Rfcm91dGluZ19oZWFkZXJfc2l6ZVxuICAgICAgOiBwa3RfY29udHJvbF9oZWFkZXJfc2l6ZVxuICAgIGNvbnN0IHBhY2tldF9sZW4gPSBwa3RfaGVhZGVyX3NpemUgKyBoZWFkZXIuYnl0ZUxlbmd0aCArIGJvZHkuYnl0ZUxlbmd0aFxuICAgIGlmIHBhY2tldF9sZW4gPiAweGZmZmYgOjogdGhyb3cgbmV3IEVycm9yIEAgYFBhY2tldCB0b28gbGFyZ2VgXG5cbiAgICBjb25zdCBwa3QgPSBCdWZmZXIuYWxsb2MgQCBwa3RfaGVhZGVyX3NpemVcbiAgICBwa3Qud3JpdGVVSW50MTZMRSBAIHNpZ25hdHVyZSwgMFxuICAgIHBrdC53cml0ZVVJbnQxNkxFIEAgcGFja2V0X2xlbiwgMlxuICAgIHBrdC53cml0ZVVJbnQxNkxFIEAgaGVhZGVyLmJ5dGVMZW5ndGgsIDRcbiAgICBwa3Qud3JpdGVVSW50OCBAIHR5cGUgfHwgMCwgNlxuICAgIHBrdC53cml0ZVVJbnQ4IEAgdHRsIHx8IGRlZmF1bHRfdHRsLCA3XG4gICAgaWYgISBpZF9yb3V0ZXIgOjpcbiAgICAgIHBrdC53cml0ZVVJbnQzMkxFIEAgMCwgOFxuICAgICAgaWYgaWRfdGFyZ2V0IDo6XG4gICAgICAgIHRocm93IG5ldyBFcnJvciBAIGBJbnZhbGlkIGlkX3RhcmdldCBmb3IgY29udHJvbCBwYWNrZXRgXG4gICAgZWxzZSA6OlxuICAgICAgcGt0LndyaXRlVUludDMyTEUgQCBpZF9yb3V0ZXIsIDhcbiAgICAgIHBrdC53cml0ZVVJbnQzMkxFIEAgaWRfdGFyZ2V0IHx8IDAsIDEyXG5cbiAgICBjb25zdCBidWYgPSBCdWZmZXIuY29uY2F0IEAjIHBrdCwgaGVhZGVyLCBib2R5XG4gICAgaWYgcGFja2V0X2xlbiAhPT0gYnVmLmJ5dGVMZW5ndGggOjpcbiAgICAgIHRocm93IG5ldyBFcnJvciBAIGBQYWNrZWQgbWVzc2FnZSBsZW5ndGggbWlzbWF0Y2ggKGxpYnJhcnkgZXJyb3IpYFxuICAgIHJldHVybiBidWZcblxuXG4gIGZ1bmN0aW9uIHBhY2tJZChpZCwgb2Zmc2V0KSA6OlxuICAgIGNvbnN0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyg0KVxuICAgIGJ1Zi53cml0ZVVJbnQzMkxFKGlkLCBvZmZzZXQpXG4gICAgcmV0dXJuIGJ1ZlxuICBmdW5jdGlvbiB1bnBhY2tJZChidWYsIG9mZnNldCkgOjpcbiAgICByZXR1cm4gYnVmLnJlYWRVSW50MzJMRShvZmZzZXQpXG5cbiAgZnVuY3Rpb24gcGFja191dGY4KHN0cikgOjpcbiAgICByZXR1cm4gQnVmZmVyLmZyb20oc3RyLCAndXRmLTgnKVxuICBmdW5jdGlvbiB1bnBhY2tfdXRmOChidWYpIDo6XG4gICAgcmV0dXJuIGFzQnVmZmVyKGJ1ZikudG9TdHJpbmcoJ3V0Zi04JylcblxuXG4gIGZ1bmN0aW9uIGFzQnVmZmVyKGJ1ZikgOjpcbiAgICBpZiBudWxsID09PSBidWYgfHwgdW5kZWZpbmVkID09PSBidWYgOjpcbiAgICAgIHJldHVybiBCdWZmZXIoMClcblxuICAgIGlmIEJ1ZmZlci5pc0J1ZmZlcihidWYpIDo6XG4gICAgICByZXR1cm4gYnVmXG5cbiAgICBpZiAnc3RyaW5nJyA9PT0gdHlwZW9mIGJ1ZiA6OlxuICAgICAgcmV0dXJuIHBhY2tfdXRmOChidWYpXG5cbiAgICBpZiB1bmRlZmluZWQgIT09IGJ1Zi5ieXRlTGVuZ3RoIDo6XG4gICAgICByZXR1cm4gQnVmZmVyLmZyb20oYnVmKSAvLyBUeXBlZEFycmF5IG9yIEFycmF5QnVmZmVyXG5cbiAgICBpZiBBcnJheS5pc0FycmF5KGJ1ZikgOjpcbiAgICAgIGlmIE51bWJlci5pc1NhZmVJbnRlZ2VyIEAgYnVmWzBdIDo6XG4gICAgICAgIHJldHVybiBCdWZmZXIuZnJvbShidWYpXG4gICAgICByZXR1cm4gQnVmZmVyLmNvbmNhdCBAIGJ1Zi5tYXAgQCBhc0J1ZmZlclxuXG5cbiAgZnVuY3Rpb24gY29uY2F0QnVmZmVycyhsc3QsIGxlbikgOjpcbiAgICBpZiAxID09PSBsc3QubGVuZ3RoIDo6IHJldHVybiBsc3RbMF1cbiAgICBpZiAwID09PSBsc3QubGVuZ3RoIDo6IHJldHVybiBCdWZmZXIoMClcbiAgICByZXR1cm4gQnVmZmVyLmNvbmNhdChsc3QpXG5cbiIsIi8qXG4gIDAxMjM0NTY3ODlhYiAgICAgLS0gMTItYnl0ZSBwYWNrZXQgaGVhZGVyIChjb250cm9sKVxuICAwMTIzNDU2Nzg5YWJjZGVmIC0tIDE2LWJ5dGUgcGFja2V0IGhlYWRlciAocm91dGluZylcbiAgXG4gIDAxLi4uLi4uLi4uLi4uLi4gLS0gdWludDE2IHNpZ25hdHVyZSA9IDB4RkUgMHhFRFxuICAuLjIzIC4uLi4uLi4uLi4uIC0tIHVpbnQxNiBwYWNrZXQgbGVuZ3RoXG5cbiAgLi4uLjQuLi4uLi4uLi4uLiAtLSB1aW50OCB0dGwgaG9wc1xuXG4gIC4uLi4uNS4uLi4uLi4uLi4gLS0gdWludDggaGVhZGVyIHR5cGVcbiAgLi4uLi4uNjcuLi4uLi4uLiAtLSB1aW50OCBoZWFkZXIgbGVuZ3RoXG5cbiAgLi4uLi4uLi44OWFiLi4uLiAtLSB1aW50MzIgaWRfcm91dGVyXG4gICAgICAgICAgICAgICAgICAgICAgNC1ieXRlIHJhbmRvbSBzcGFjZSBhbGxvd3MgMSBtaWxsaW9uIG5vZGVzIHdpdGhcbiAgICAgICAgICAgICAgICAgICAgICAwLjAyJSBjaGFuY2Ugb2YgdHdvIG5vZGVzIHNlbGVjdGluZyB0aGUgc2FtZSBpZFxuXG4gIC4uLi4uLi4uLi4uLmNkZWYgLS0gdWludDMyIGlkX3RhcmdldCAod2hlbiBpZF9yb3V0ZXIgIT09IDApXG4gICAgICAgICAgICAgICAgICAgICAgNC1ieXRlIHJhbmRvbSBzcGFjZSBhbGxvd3MgMSBtaWxsaW9uIG5vZGVzIHdpdGhcbiAgICAgICAgICAgICAgICAgICAgICAwLjAyJSBjaGFuY2Ugb2YgdHdvIG5vZGVzIHNlbGVjdGluZyB0aGUgc2FtZSBpZFxuICovXG5cbmltcG9ydCBhc1BhY2tldFBhcnNlckFQSSBmcm9tICcuL2Jhc2ljJ1xuXG5jb25zdCBzaWduYXR1cmUgPSAweGVkZmVcbmNvbnN0IHBrdF9jb250cm9sX2hlYWRlcl9zaXplID0gMTJcbmNvbnN0IHBrdF9yb3V0aW5nX2hlYWRlcl9zaXplID0gMTZcbmNvbnN0IGRlZmF1bHRfdHRsID0gMzFcblxuY29uc3QgbGl0dGxlX2VuZGlhbiA9IHRydWVcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gY3JlYXRlRGF0YVZpZXdQYWNrZXRQYXJzZXIob3B0aW9ucz17fSkgOjpcbiAgY29uc3QgX1RleHRFbmNvZGVyXyA9IG9wdGlvbnMuVGV4dEVuY29kZXIgfHwgVGV4dEVuY29kZXJcbiAgY29uc3QgX1RleHREZWNvZGVyXyA9IG9wdGlvbnMuVGV4dERlY29kZXIgfHwgVGV4dERlY29kZXJcblxuICByZXR1cm4gYXNQYWNrZXRQYXJzZXJBUEkgQDpcbiAgICBwYXJzZUhlYWRlciwgcGFja01lc3NhZ2VcbiAgICBwYWNrSWQsIHVucGFja0lkLCBwYWNrX3V0ZjgsIHVucGFja191dGY4XG5cbiAgICBhc0J1ZmZlciwgY29uY2F0QnVmZmVyc1xuXG5cbiAgZnVuY3Rpb24gcGFyc2VIZWFkZXIoYnVmLCBkZWNyZW1lbnRfdHRsKSA6OlxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3IEAgYnVmXG5cbiAgICBjb25zdCBzaWcgPSBkdi5nZXRVaW50MTYgQCAwLCBsaXR0bGVfZW5kaWFuXG4gICAgaWYgc2lnbmF0dXJlICE9PSBzaWcgOjpcbiAgICAgIHRocm93IG5ldyBFcnJvciBAIGBQYWNrZXQgc3RyZWFtIGZyYW1pbmcgZXJyb3IgKGZvdW5kOiAke3NpZy50b1N0cmluZygxNil9IGV4cGVjdGVkOiAke3NpZ25hdHVyZS50b1N0cmluZygxNil9KWBcblxuICAgIC8vIHVwIHRvIDY0ayBwYWNrZXQgbGVuZ3RoOyBsZW5ndGggaW5jbHVkZXMgaGVhZGVyXG4gICAgY29uc3QgcGFja2V0X2xlbiA9IGR2LmdldFVpbnQxNiBAIDIsIGxpdHRsZV9lbmRpYW5cbiAgICBsZXQgaGVhZGVyX2xlbiA9IGR2LmdldFVpbnQxNiBAIDQsIGxpdHRsZV9lbmRpYW5cbiAgICBjb25zdCB0eXBlID0gZHYuZ2V0VWludDggQCA2LCBsaXR0bGVfZW5kaWFuXG5cbiAgICBsZXQgdHRsID0gZHYuZ2V0VWludDggQCA3LCBsaXR0bGVfZW5kaWFuXG4gICAgaWYgZGVjcmVtZW50X3R0bCA6OlxuICAgICAgdHRsID0gTWF0aC5tYXggQCAwLCB0dGwgLSAxXG4gICAgICBkdi5zZXRVaW50OCBAIDcsIHR0bCwgbGl0dGxlX2VuZGlhblxuXG4gICAgY29uc3QgaWRfcm91dGVyID0gZHYuZ2V0VWludDMyIEAgOCwgbGl0dGxlX2VuZGlhblxuICAgIGNvbnN0IGluZm8gPSBAe30gdHlwZSwgdHRsLCBpZF9yb3V0ZXJcblxuICAgIGlmIDAgPT09IGlkX3JvdXRlciA6OlxuICAgICAgcmV0dXJuIEA6IGluZm8sIHBhY2tldF9sZW4sIGhlYWRlcl9sZW4sIHBrdF9oZWFkZXJfbGVuOiBwa3RfY29udHJvbF9oZWFkZXJfc2l6ZVxuICAgIGVsc2UgaWYgcGt0X3JvdXRpbmdfaGVhZGVyX3NpemUgPiBidWYuYnl0ZUxlbmd0aCA6OlxuICAgICAgcmV0dXJuIG51bGwgLy8gdGhpcyBidWZmZXIgaXMgZnJhZ21lbnRlZCBiZWZvcmUgaWRfdGFyZ2V0XG4gICAgZWxzZSA6OlxuICAgICAgaW5mby5pZF90YXJnZXQgPSBkdi5nZXRVaW50MzIgQCAxMiwgbGl0dGxlX2VuZGlhblxuICAgICAgcmV0dXJuIEA6IGluZm8sIHBhY2tldF9sZW4sIGhlYWRlcl9sZW4sIHBrdF9oZWFkZXJfbGVuOiBwa3Rfcm91dGluZ19oZWFkZXJfc2l6ZVxuXG5cbiAgZnVuY3Rpb24gcGFja01lc3NhZ2UoLi4uYXJncykgOjpcbiAgICBsZXQge3R5cGUsIHR0bCwgaWRfcm91dGVyLCBpZF90YXJnZXQsIGhlYWRlciwgYm9keX0gPSBPYmplY3QuYXNzaWduIEAge30sIC4uLmFyZ3NcbiAgICBoZWFkZXIgPSBhc0J1ZmZlcihoZWFkZXIsICdoZWFkZXInKVxuICAgIGJvZHkgPSBhc0J1ZmZlcihib2R5LCAnYm9keScpXG5cbiAgICBjb25zdCBwa3RfaGVhZGVyX3NpemUgPSBpZF9yb3V0ZXJcbiAgICAgID8gcGt0X3JvdXRpbmdfaGVhZGVyX3NpemVcbiAgICAgIDogcGt0X2NvbnRyb2xfaGVhZGVyX3NpemVcbiAgICBjb25zdCBsZW4gPSBwa3RfaGVhZGVyX3NpemUgKyBoZWFkZXIuYnl0ZUxlbmd0aCArIGJvZHkuYnl0ZUxlbmd0aFxuICAgIGlmIGxlbiA+IDB4ZmZmZiA6OiB0aHJvdyBuZXcgRXJyb3IgQCBgUGFja2V0IHRvbyBsYXJnZWBcblxuICAgIGNvbnN0IGFycmF5ID0gbmV3IEFycmF5QnVmZmVyKGxlbilcblxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3IEAgYXJyYXksIDAsIHBrdF9oZWFkZXJfc2l6ZVxuICAgIGR2LnNldFVpbnQxNiBAICAwLCBzaWduYXR1cmUsIGxpdHRsZV9lbmRpYW5cbiAgICBkdi5zZXRVaW50MTYgQCAgMiwgbGVuLCBsaXR0bGVfZW5kaWFuXG4gICAgZHYuc2V0VWludDE2IEAgIDQsIGhlYWRlci5ieXRlTGVuZ3RoLCBsaXR0bGVfZW5kaWFuXG4gICAgZHYuc2V0VWludDggIEAgIDYsIHR5cGUgfHwgMCwgbGl0dGxlX2VuZGlhblxuICAgIGR2LnNldFVpbnQ4ICBAICA3LCB0dGwgfHwgZGVmYXVsdF90dGwsIGxpdHRsZV9lbmRpYW5cbiAgICBpZiAhIGlkX3JvdXRlciA6OlxuICAgICAgZHYuc2V0VWludDMyIEAgIDgsIDAsIGxpdHRsZV9lbmRpYW5cbiAgICAgIGlmIGlkX3RhcmdldCA6OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IgQCBgSW52YWxpZCBpZF90YXJnZXQgZm9yIGNvbnRyb2wgcGFja2V0YFxuICAgIGVsc2UgOjpcbiAgICAgIGR2LnNldFVpbnQzMiBAICA4LCBpZF9yb3V0ZXIsIGxpdHRsZV9lbmRpYW5cbiAgICAgIGR2LnNldFVpbnQzMiBAIDEyLCBpZF90YXJnZXQgfHwgMCwgbGl0dGxlX2VuZGlhblxuXG4gICAgY29uc3QgdTggPSBuZXcgVWludDhBcnJheShhcnJheSlcbiAgICB1OC5zZXQgQCBuZXcgVWludDhBcnJheShoZWFkZXIpLCBwa3RfaGVhZGVyX3NpemVcbiAgICB1OC5zZXQgQCBuZXcgVWludDhBcnJheShib2R5KSwgcGt0X2hlYWRlcl9zaXplICsgaGVhZGVyLmJ5dGVMZW5ndGhcbiAgICByZXR1cm4gYXJyYXlcblxuXG4gIGZ1bmN0aW9uIHBhY2tJZChpZCwgb2Zmc2V0KSA6OlxuICAgIGNvbnN0IGJ1ZiA9IG5ldyBBcnJheUJ1ZmZlcig0KVxuICAgIG5ldyBEYXRhVmlldyhidWYpLnNldFVpbnQzMiBAIG9mZnNldHx8MCwgaWQsIGxpdHRsZV9lbmRpYW5cbiAgICByZXR1cm4gYnVmXG4gIGZ1bmN0aW9uIHVucGFja0lkKGJ1Ziwgb2Zmc2V0KSA6OlxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3IEAgYXNCdWZmZXIoYnVmKVxuICAgIHJldHVybiBkdi5nZXRVaW50MzIgQCBvZmZzZXR8fDAsIGxpdHRsZV9lbmRpYW5cblxuICBmdW5jdGlvbiBwYWNrX3V0Zjgoc3RyKSA6OlxuICAgIGNvbnN0IHRlID0gbmV3IF9UZXh0RW5jb2Rlcl8oJ3V0Zi04JylcbiAgICByZXR1cm4gdGUuZW5jb2RlKHN0ci50b1N0cmluZygpKS5idWZmZXJcbiAgZnVuY3Rpb24gdW5wYWNrX3V0ZjgoYnVmKSA6OlxuICAgIGNvbnN0IHRkID0gbmV3IF9UZXh0RGVjb2Rlcl8oJ3V0Zi04JylcbiAgICByZXR1cm4gdGQuZGVjb2RlIEAgYXNCdWZmZXIgQCBidWZcblxuXG4gIGZ1bmN0aW9uIGFzQnVmZmVyKGJ1ZikgOjpcbiAgICBpZiBudWxsID09PSBidWYgfHwgdW5kZWZpbmVkID09PSBidWYgOjpcbiAgICAgIHJldHVybiBuZXcgQXJyYXlCdWZmZXIoMClcblxuICAgIGlmIHVuZGVmaW5lZCAhPT0gYnVmLmJ5dGVMZW5ndGggOjpcbiAgICAgIGlmIHVuZGVmaW5lZCA9PT0gYnVmLmJ1ZmZlciA6OlxuICAgICAgICByZXR1cm4gYnVmXG5cbiAgICAgIGlmIEFycmF5QnVmZmVyLmlzVmlldyhidWYpIDo6XG4gICAgICAgIHJldHVybiBidWYuYnVmZmVyXG5cbiAgICAgIGlmICdmdW5jdGlvbicgPT09IHR5cGVvZiBidWYucmVhZFVJbnQzMkxFIDo6XG4gICAgICAgIHJldHVybiBVaW50OEFycmF5LmZyb20oYnVmKS5idWZmZXIgLy8gTm9kZUpTIEJ1ZmZlclxuXG4gICAgICByZXR1cm4gYnVmXG5cbiAgICBpZiAnc3RyaW5nJyA9PT0gdHlwZW9mIGJ1ZiA6OlxuICAgICAgcmV0dXJuIHBhY2tfdXRmOChidWYpXG5cbiAgICBpZiBBcnJheS5pc0FycmF5KGJ1ZikgOjpcbiAgICAgIGlmIE51bWJlci5pc1NhZmVJbnRlZ2VyIEAgYnVmWzBdIDo6XG4gICAgICAgIHJldHVybiBVaW50OEFycmF5LmZyb20oYnVmKS5idWZmZXJcbiAgICAgIHJldHVybiBjb25jYXQgQCBidWYubWFwIEAgYXNCdWZmZXJcblxuXG4gIGZ1bmN0aW9uIGNvbmNhdEJ1ZmZlcnMobHN0LCBsZW4pIDo6XG4gICAgaWYgMSA9PT0gbHN0Lmxlbmd0aCA6OiByZXR1cm4gbHN0WzBdXG4gICAgaWYgMCA9PT0gbHN0Lmxlbmd0aCA6OiByZXR1cm4gbmV3IEFycmF5QnVmZmVyKDApXG5cbiAgICBpZiBudWxsID09IGxlbiA6OlxuICAgICAgbGVuID0gMFxuICAgICAgZm9yIGNvbnN0IGFyciBvZiBsc3QgOjpcbiAgICAgICAgbGVuICs9IGFyci5ieXRlTGVuZ3RoXG5cbiAgICBjb25zdCB1OCA9IG5ldyBVaW50OEFycmF5KGxlbilcbiAgICBsZXQgb2Zmc2V0ID0gMFxuICAgIGZvciBjb25zdCBhcnIgb2YgbHN0IDo6XG4gICAgICB1OC5zZXQgQCBuZXcgVWludDhBcnJheShhcnIpLCBvZmZzZXRcbiAgICAgIG9mZnNldCArPSBhcnIuYnl0ZUxlbmd0aFxuICAgIHJldHVybiB1OC5idWZmZXJcblxuIiwiaW1wb3J0IGFzUGFja2V0UGFyc2VyQVBJIGZyb20gJy4vYmFzaWMnXG5pbXBvcnQgY3JlYXRlQnVmZmVyUGFja2V0UGFyc2VyIGZyb20gJy4vYnVmZmVyJ1xuaW1wb3J0IGNyZWF0ZURhdGFWaWV3UGFja2V0UGFyc2VyIGZyb20gJy4vZGF0YXZpZXcnXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIGNyZWF0ZVBhY2tldFBhcnNlciguLi5hcmdzKSA6OlxuICByZXR1cm4gY3JlYXRlQnVmZmVyUGFja2V0UGFyc2VyKC4uLmFyZ3MpXG5cbk9iamVjdC5hc3NpZ24gQCBjcmVhdGVQYWNrZXRQYXJzZXIsIEB7fVxuICBhc1BhY2tldFBhcnNlckFQSVxuICBjcmVhdGVCdWZmZXJQYWNrZXRQYXJzZXJcbiAgY3JlYXRlRGF0YVZpZXdQYWNrZXRQYXJzZXJcblxuIl0sIm5hbWVzIjpbImFzUGFja2V0UGFyc2VyQVBJIiwicGFja2V0X2ltcGxfbWV0aG9kcyIsIm1zZ19vYmpfcHJvdG8iLCJfcmF3XyIsInNsaWNlIiwiYm9keV9vZmZzZXQiLCJoZWFkZXJfb2Zmc2V0IiwiYnVmIiwib2Zmc2V0IiwidW5wYWNrSWQiLCJwYWNrZXRQYXJzZXJBUEkiLCJPYmplY3QiLCJhc3NpZ24iLCJjcmVhdGUiLCJwYWNrTWVzc2FnZU9iaiIsImFyZ3MiLCJtc2dfcmF3IiwicGFja01lc3NhZ2UiLCJtc2dfb2JqIiwiYXNNc2dPYmoiLCJwYXJzZUhlYWRlciIsImRlZmluZVByb3BlcnRpZXMiLCJ2YWx1ZSIsImluZm8iLCJwa3RfaGVhZGVyX2xlbiIsInBhY2tldF9sZW4iLCJoZWFkZXJfbGVuIiwicGFja2V0U3RyZWFtIiwib3B0aW9ucyIsImRlY3JlbWVudF90dGwiLCJ0aXAiLCJxQnl0ZUxlbiIsInEiLCJmZWVkIiwiZGF0YSIsImNvbXBsZXRlIiwiYXNCdWZmZXIiLCJwdXNoIiwiYnl0ZUxlbmd0aCIsIm1zZyIsInBhcnNlVGlwTWVzc2FnZSIsInVuZGVmaW5lZCIsImxlbmd0aCIsImNvbmNhdEJ1ZmZlcnMiLCJsZW4iLCJieXRlcyIsIm4iLCJ0cmFpbGluZ0J5dGVzIiwicGFydHMiLCJzcGxpY2UiLCJ0YWlsIiwic2lnbmF0dXJlIiwicGt0X2NvbnRyb2xfaGVhZGVyX3NpemUiLCJwa3Rfcm91dGluZ19oZWFkZXJfc2l6ZSIsImRlZmF1bHRfdHRsIiwiY3JlYXRlQnVmZmVyUGFja2V0UGFyc2VyIiwicGFja191dGY4IiwidW5wYWNrX3V0ZjgiLCJzaWciLCJyZWFkVUludDE2TEUiLCJFcnJvciIsInRvU3RyaW5nIiwidHlwZSIsInJlYWRVSW50OCIsInR0bCIsIk1hdGgiLCJtYXgiLCJ3cml0ZVVJbnQ4IiwiaWRfcm91dGVyIiwicmVhZFVJbnQzMkxFIiwiaWRfdGFyZ2V0IiwiaGVhZGVyIiwiYm9keSIsInBrdF9oZWFkZXJfc2l6ZSIsInBrdCIsIkJ1ZmZlciIsImFsbG9jIiwid3JpdGVVSW50MTZMRSIsIndyaXRlVUludDMyTEUiLCJjb25jYXQiLCJwYWNrSWQiLCJpZCIsInN0ciIsImZyb20iLCJpc0J1ZmZlciIsIkFycmF5IiwiaXNBcnJheSIsIk51bWJlciIsImlzU2FmZUludGVnZXIiLCJtYXAiLCJsc3QiLCJsaXR0bGVfZW5kaWFuIiwiY3JlYXRlRGF0YVZpZXdQYWNrZXRQYXJzZXIiLCJfVGV4dEVuY29kZXJfIiwiVGV4dEVuY29kZXIiLCJfVGV4dERlY29kZXJfIiwiVGV4dERlY29kZXIiLCJkdiIsIkRhdGFWaWV3IiwiZ2V0VWludDE2IiwiZ2V0VWludDgiLCJzZXRVaW50OCIsImdldFVpbnQzMiIsImFycmF5IiwiQXJyYXlCdWZmZXIiLCJzZXRVaW50MTYiLCJzZXRVaW50MzIiLCJ1OCIsIlVpbnQ4QXJyYXkiLCJzZXQiLCJ0ZSIsImVuY29kZSIsImJ1ZmZlciIsInRkIiwiZGVjb2RlIiwiaXNWaWV3IiwiYXJyIiwiY3JlYXRlUGFja2V0UGFyc2VyIl0sIm1hcHBpbmdzIjoiOztBQUNlLFNBQVNBLGlCQUFULENBQTJCQyxtQkFBM0IsRUFBZ0Q7UUFDdkQ7ZUFBQTtlQUFBO1lBQUE7aUJBQUE7WUFBQSxLQU1KQSxtQkFORjs7UUFRTUMsZ0JBQWtCO2dCQUNWO2FBQVUsS0FBS0MsS0FBTCxDQUFXQyxLQUFYLENBQW1CLEtBQUtDLFdBQXhCLENBQVA7S0FETztrQkFFUjthQUFVLEtBQUtGLEtBQUwsQ0FBV0MsS0FBWCxDQUFtQixLQUFLRSxhQUF4QixFQUF1QyxLQUFLRCxXQUE1QyxDQUFQO0tBRks7YUFHYkUsR0FBVCxFQUFjQyxTQUFPLENBQXJCLEVBQXdCO2FBQVVDLFNBQVNGLE9BQU8sS0FBS0osS0FBckIsRUFBNEJLLE1BQTVCLENBQVA7S0FITCxFQUF4Qjs7UUFLTUUsa0JBQWtCQyxPQUFPQyxNQUFQLENBQ3RCRCxPQUFPRSxNQUFQLENBQWMsSUFBZCxDQURzQixFQUV0QlosbUJBRnNCLEVBR3RCO2tCQUFBO2dCQUFBO1lBQUE7aUJBQUEsRUFIc0IsQ0FBeEI7U0FRT1MsZUFBUDs7V0FHU0ksY0FBVCxDQUF3QixHQUFHQyxJQUEzQixFQUFpQztVQUN6QkMsVUFBVUMsWUFBYyxHQUFHRixJQUFqQixDQUFoQjtVQUNNRyxVQUFVQyxTQUFXQyxZQUFjSixPQUFkLENBQVgsQ0FBaEI7V0FDT0ssZ0JBQVAsQ0FBMEJILE9BQTFCLEVBQXFDO2FBQzVCLEVBQUlJLE9BQU9OLE9BQVgsRUFENEIsRUFBckM7V0FFT0UsT0FBUDs7O1dBR09DLFFBQVQsQ0FBa0IsRUFBQ0ksSUFBRCxFQUFPQyxjQUFQLEVBQXVCQyxVQUF2QixFQUFtQ0MsVUFBbkMsRUFBK0N2QixLQUEvQyxFQUFsQixFQUF5RTtRQUNuRUUsY0FBY21CLGlCQUFpQkUsVUFBbkM7UUFDR3JCLGNBQWNvQixVQUFqQixFQUE4QjtvQkFDZCxJQUFkLENBRDRCO0tBRzlCLE1BQU1QLFVBQVVQLE9BQU9FLE1BQVAsQ0FBZ0JYLGFBQWhCLEVBQWlDO3FCQUNoQyxFQUFJb0IsT0FBT0UsY0FBWCxFQURnQzttQkFFbEMsRUFBSUYsT0FBT2pCLFdBQVgsRUFGa0M7a0JBR25DLEVBQUlpQixPQUFPRyxVQUFYLEVBSG1DO2FBSXhDLEVBQUlILE9BQU9uQixLQUFYLEVBSndDLEVBQWpDLENBQWhCOztXQU1PUSxPQUFPQyxNQUFQLENBQWdCTSxPQUFoQixFQUF5QkssSUFBekIsQ0FBUDs7O1dBR09JLFlBQVQsQ0FBc0JDLE9BQXRCLEVBQStCO1FBQzFCLENBQUVBLE9BQUwsRUFBZTtnQkFBVyxFQUFWOzs7VUFFVkMsZ0JBQ0osUUFBUUQsUUFBUUMsYUFBaEIsR0FDSSxJQURKLEdBQ1csQ0FBQyxDQUFFRCxRQUFRQyxhQUZ4Qjs7UUFJSUMsTUFBSSxJQUFSO1FBQWNDLFdBQVcsQ0FBekI7UUFBNEJDLElBQUksRUFBaEM7V0FDT0MsSUFBUDs7YUFFU0EsSUFBVCxDQUFjQyxJQUFkLEVBQW9CQyxXQUFTLEVBQTdCLEVBQWlDO2FBQ3hCQyxTQUFTRixJQUFULENBQVA7UUFDRUcsSUFBRixDQUFTSCxJQUFUO2tCQUNZQSxLQUFLSSxVQUFqQjs7YUFFTSxDQUFOLEVBQVU7Y0FDRkMsTUFBTUMsaUJBQVo7WUFDR0MsY0FBY0YsR0FBakIsRUFBdUI7bUJBQ1pGLElBQVQsQ0FBZ0JFLEdBQWhCO1NBREYsTUFFSyxPQUFPSixRQUFQOzs7O2FBR0FLLGVBQVQsR0FBMkI7VUFDdEIsU0FBU1YsR0FBWixFQUFrQjtZQUNiLE1BQU1FLEVBQUVVLE1BQVgsRUFBb0I7OztZQUVqQixJQUFJVixFQUFFVSxNQUFULEVBQWtCO2NBQ1osQ0FBSUMsY0FBZ0JYLENBQWhCLEVBQW1CRCxRQUFuQixDQUFKLENBQUo7OztjQUVJWCxZQUFjWSxFQUFFLENBQUYsQ0FBZCxFQUFvQkgsYUFBcEIsQ0FBTjtZQUNHLFNBQVNDLEdBQVosRUFBa0I7Ozs7O1lBRWRjLE1BQU1kLElBQUlMLFVBQWhCO1VBQ0dNLFdBQVdhLEdBQWQsRUFBb0I7Ozs7VUFHaEJDLFFBQVEsQ0FBWjtVQUFlQyxJQUFJLENBQW5CO2FBQ01ELFFBQVFELEdBQWQsRUFBb0I7aUJBQ1RaLEVBQUVjLEdBQUYsRUFBT1IsVUFBaEI7OztZQUVJUyxnQkFBZ0JGLFFBQVFELEdBQTlCO1VBQ0csTUFBTUcsYUFBVCxFQUF5Qjs7Y0FDakJDLFFBQVFoQixFQUFFaUIsTUFBRixDQUFTLENBQVQsRUFBWUgsQ0FBWixDQUFkO29CQUNZRixHQUFaOztZQUVJekMsS0FBSixHQUFZd0MsY0FBZ0JLLEtBQWhCLEVBQXVCSixHQUF2QixDQUFaO09BSkYsTUFNSzs7Y0FDR0ksUUFBUSxNQUFNaEIsRUFBRVUsTUFBUixHQUFpQixFQUFqQixHQUFzQlYsRUFBRWlCLE1BQUYsQ0FBUyxDQUFULEVBQVlILElBQUUsQ0FBZCxDQUFwQztjQUNNSSxPQUFPbEIsRUFBRSxDQUFGLENBQWI7O2NBRU1LLElBQU4sQ0FBYWEsS0FBSzlDLEtBQUwsQ0FBVyxDQUFYLEVBQWMsQ0FBQzJDLGFBQWYsQ0FBYjtVQUNFLENBQUYsSUFBT0csS0FBSzlDLEtBQUwsQ0FBVyxDQUFDMkMsYUFBWixDQUFQO29CQUNZSCxHQUFaOztZQUVJekMsS0FBSixHQUFZd0MsY0FBZ0JLLEtBQWhCLEVBQXVCSixHQUF2QixDQUFaOzs7O2NBR00xQixVQUFVQyxTQUFTVyxHQUFULENBQWhCO2NBQ00sSUFBTjtlQUNPWixPQUFQOzs7Ozs7QUM1R1I7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQXFCQSxBQUVBLE1BQU1pQyxZQUFZLE1BQWxCO0FBQ0EsTUFBTUMsMEJBQTBCLEVBQWhDO0FBQ0EsTUFBTUMsMEJBQTBCLEVBQWhDO0FBQ0EsTUFBTUMsY0FBYyxFQUFwQjs7QUFFQSxBQUFlLFNBQVNDLHdCQUFULENBQWtDM0IsVUFBUSxFQUExQyxFQUE4QztTQUNwRDVCLGtCQUFvQjtlQUFBLEVBQ1ppQixXQURZO1VBQUEsRUFFakJSLFFBRmlCLEVBRVArQyxTQUZPLEVBRUlDLFdBRko7O1lBQUEsRUFJZmQsYUFKZSxFQUFwQixDQUFQOztXQU9TdkIsV0FBVCxDQUFxQmIsR0FBckIsRUFBMEJzQixhQUExQixFQUF5QztVQUNqQzZCLE1BQU1uRCxJQUFJb0QsWUFBSixDQUFtQixDQUFuQixDQUFaO1FBQ0dSLGNBQWNPLEdBQWpCLEVBQXVCO1lBQ2YsSUFBSUUsS0FBSixDQUFhLHVDQUFzQ0YsSUFBSUcsUUFBSixDQUFhLEVBQWIsQ0FBaUIsY0FBYVYsVUFBVVUsUUFBVixDQUFtQixFQUFuQixDQUF1QixHQUF4RyxDQUFOOzs7O1VBR0lwQyxhQUFhbEIsSUFBSW9ELFlBQUosQ0FBbUIsQ0FBbkIsQ0FBbkI7UUFDSWpDLGFBQWFuQixJQUFJb0QsWUFBSixDQUFtQixDQUFuQixDQUFqQjtVQUNNRyxPQUFPdkQsSUFBSXdELFNBQUosQ0FBZ0IsQ0FBaEIsQ0FBYjs7UUFFSUMsTUFBTXpELElBQUl3RCxTQUFKLENBQWdCLENBQWhCLENBQVY7UUFDR2xDLGFBQUgsRUFBbUI7WUFDWG9DLEtBQUtDLEdBQUwsQ0FBVyxDQUFYLEVBQWNGLE1BQU0sQ0FBcEIsQ0FBTjtVQUNJRyxVQUFKLENBQWlCSCxHQUFqQixFQUFzQixDQUF0Qjs7O1VBRUlJLFlBQVk3RCxJQUFJOEQsWUFBSixDQUFtQixDQUFuQixDQUFsQjtVQUNNOUMsT0FBTyxFQUFJdUMsSUFBSixFQUFVRSxHQUFWLEVBQWVJLFNBQWYsRUFBYjs7UUFFRyxNQUFNQSxTQUFULEVBQXFCO2FBQ1YsRUFBQzdDLElBQUQsRUFBT0UsVUFBUCxFQUFtQkMsVUFBbkIsRUFBK0JGLGdCQUFnQjRCLHVCQUEvQyxFQUFUO0tBREYsTUFFSyxJQUFHQywwQkFBMEI5QyxJQUFJK0IsVUFBakMsRUFBOEM7YUFDMUMsSUFBUCxDQURpRDtLQUE5QyxNQUVBO2FBQ0VnQyxTQUFMLEdBQWlCL0QsSUFBSThELFlBQUosQ0FBbUIsRUFBbkIsQ0FBakI7ZUFDUyxFQUFDOUMsSUFBRCxFQUFPRSxVQUFQLEVBQW1CQyxVQUFuQixFQUErQkYsZ0JBQWdCNkIsdUJBQS9DLEVBQVQ7Ozs7V0FHS3BDLFdBQVQsQ0FBcUIsR0FBR0YsSUFBeEIsRUFBOEI7UUFDeEIsRUFBQytDLElBQUQsRUFBT0UsR0FBUCxFQUFZSSxTQUFaLEVBQXVCRSxTQUF2QixFQUFrQ0MsTUFBbEMsRUFBMENDLElBQTFDLEtBQWtEN0QsT0FBT0MsTUFBUCxDQUFnQixFQUFoQixFQUFvQixHQUFHRyxJQUF2QixDQUF0RDthQUNTcUIsU0FBU21DLE1BQVQsQ0FBVDtXQUNPbkMsU0FBU29DLElBQVQsQ0FBUDs7VUFFTUMsa0JBQWtCTCxZQUNwQmYsdUJBRG9CLEdBRXBCRCx1QkFGSjtVQUdNM0IsYUFBYWdELGtCQUFrQkYsT0FBT2pDLFVBQXpCLEdBQXNDa0MsS0FBS2xDLFVBQTlEO1FBQ0diLGFBQWEsTUFBaEIsRUFBeUI7WUFBTyxJQUFJbUMsS0FBSixDQUFhLGtCQUFiLENBQU47OztVQUVwQmMsTUFBTUMsT0FBT0MsS0FBUCxDQUFlSCxlQUFmLENBQVo7UUFDSUksYUFBSixDQUFvQjFCLFNBQXBCLEVBQStCLENBQS9CO1FBQ0kwQixhQUFKLENBQW9CcEQsVUFBcEIsRUFBZ0MsQ0FBaEM7UUFDSW9ELGFBQUosQ0FBb0JOLE9BQU9qQyxVQUEzQixFQUF1QyxDQUF2QztRQUNJNkIsVUFBSixDQUFpQkwsUUFBUSxDQUF6QixFQUE0QixDQUE1QjtRQUNJSyxVQUFKLENBQWlCSCxPQUFPVixXQUF4QixFQUFxQyxDQUFyQztRQUNHLENBQUVjLFNBQUwsRUFBaUI7VUFDWFUsYUFBSixDQUFvQixDQUFwQixFQUF1QixDQUF2QjtVQUNHUixTQUFILEVBQWU7Y0FDUCxJQUFJVixLQUFKLENBQWEsc0NBQWIsQ0FBTjs7S0FISixNQUlLO1VBQ0NrQixhQUFKLENBQW9CVixTQUFwQixFQUErQixDQUEvQjtVQUNJVSxhQUFKLENBQW9CUixhQUFhLENBQWpDLEVBQW9DLEVBQXBDOzs7VUFFSS9ELE1BQU1vRSxPQUFPSSxNQUFQLENBQWdCLENBQUNMLEdBQUQsRUFBTUgsTUFBTixFQUFjQyxJQUFkLENBQWhCLENBQVo7UUFDRy9DLGVBQWVsQixJQUFJK0IsVUFBdEIsRUFBbUM7WUFDM0IsSUFBSXNCLEtBQUosQ0FBYSxnREFBYixDQUFOOztXQUNLckQsR0FBUDs7O1dBR095RSxNQUFULENBQWdCQyxFQUFoQixFQUFvQnpFLE1BQXBCLEVBQTRCO1VBQ3BCRCxNQUFNb0UsT0FBT0MsS0FBUCxDQUFhLENBQWIsQ0FBWjtRQUNJRSxhQUFKLENBQWtCRyxFQUFsQixFQUFzQnpFLE1BQXRCO1dBQ09ELEdBQVA7O1dBQ09FLFFBQVQsQ0FBa0JGLEdBQWxCLEVBQXVCQyxNQUF2QixFQUErQjtXQUN0QkQsSUFBSThELFlBQUosQ0FBaUI3RCxNQUFqQixDQUFQOzs7V0FFT2dELFNBQVQsQ0FBbUIwQixHQUFuQixFQUF3QjtXQUNmUCxPQUFPUSxJQUFQLENBQVlELEdBQVosRUFBaUIsT0FBakIsQ0FBUDs7V0FDT3pCLFdBQVQsQ0FBcUJsRCxHQUFyQixFQUEwQjtXQUNqQjZCLFNBQVM3QixHQUFULEVBQWNzRCxRQUFkLENBQXVCLE9BQXZCLENBQVA7OztXQUdPekIsUUFBVCxDQUFrQjdCLEdBQWxCLEVBQXVCO1FBQ2xCLFNBQVNBLEdBQVQsSUFBZ0JrQyxjQUFjbEMsR0FBakMsRUFBdUM7YUFDOUJvRSxPQUFPLENBQVAsQ0FBUDs7O1FBRUNBLE9BQU9TLFFBQVAsQ0FBZ0I3RSxHQUFoQixDQUFILEVBQTBCO2FBQ2pCQSxHQUFQOzs7UUFFQyxhQUFhLE9BQU9BLEdBQXZCLEVBQTZCO2FBQ3BCaUQsVUFBVWpELEdBQVYsQ0FBUDs7O1FBRUNrQyxjQUFjbEMsSUFBSStCLFVBQXJCLEVBQWtDO2FBQ3pCcUMsT0FBT1EsSUFBUCxDQUFZNUUsR0FBWixDQUFQLENBRGdDO0tBR2xDLElBQUc4RSxNQUFNQyxPQUFOLENBQWMvRSxHQUFkLENBQUgsRUFBd0I7VUFDbkJnRixPQUFPQyxhQUFQLENBQXVCakYsSUFBSSxDQUFKLENBQXZCLENBQUgsRUFBbUM7ZUFDMUJvRSxPQUFPUSxJQUFQLENBQVk1RSxHQUFaLENBQVA7O2FBQ0tvRSxPQUFPSSxNQUFQLENBQWdCeEUsSUFBSWtGLEdBQUosQ0FBVXJELFFBQVYsQ0FBaEIsQ0FBUDs7OztXQUdLTyxhQUFULENBQXVCK0MsR0FBdkIsRUFBNEI5QyxHQUE1QixFQUFpQztRQUM1QixNQUFNOEMsSUFBSWhELE1BQWIsRUFBc0I7YUFBUWdELElBQUksQ0FBSixDQUFQOztRQUNwQixNQUFNQSxJQUFJaEQsTUFBYixFQUFzQjthQUFRaUMsT0FBTyxDQUFQLENBQVA7O1dBQ2hCQSxPQUFPSSxNQUFQLENBQWNXLEdBQWQsQ0FBUDs7OztBQ2pJSjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBcUJBLEFBRUEsTUFBTXZDLGNBQVksTUFBbEI7QUFDQSxNQUFNQyw0QkFBMEIsRUFBaEM7QUFDQSxNQUFNQyw0QkFBMEIsRUFBaEM7QUFDQSxNQUFNQyxnQkFBYyxFQUFwQjs7QUFFQSxNQUFNcUMsZ0JBQWdCLElBQXRCOztBQUVBLEFBQWUsU0FBU0MsMEJBQVQsQ0FBb0NoRSxVQUFRLEVBQTVDLEVBQWdEO1FBQ3ZEaUUsZ0JBQWdCakUsUUFBUWtFLFdBQVIsSUFBdUJBLFdBQTdDO1FBQ01DLGdCQUFnQm5FLFFBQVFvRSxXQUFSLElBQXVCQSxXQUE3Qzs7U0FFT2hHLGtCQUFvQjtlQUFBLEVBQ1ppQixXQURZO1VBQUEsRUFFakJSLFFBRmlCLEVBRVArQyxTQUZPLEVBRUlDLFdBRko7O1lBQUEsRUFJZmQsYUFKZSxFQUFwQixDQUFQOztXQU9TdkIsV0FBVCxDQUFxQmIsR0FBckIsRUFBMEJzQixhQUExQixFQUF5QztVQUNqQ29FLEtBQUssSUFBSUMsUUFBSixDQUFlM0YsR0FBZixDQUFYOztVQUVNbUQsTUFBTXVDLEdBQUdFLFNBQUgsQ0FBZSxDQUFmLEVBQWtCUixhQUFsQixDQUFaO1FBQ0d4QyxnQkFBY08sR0FBakIsRUFBdUI7WUFDZixJQUFJRSxLQUFKLENBQWEsdUNBQXNDRixJQUFJRyxRQUFKLENBQWEsRUFBYixDQUFpQixjQUFhVixZQUFVVSxRQUFWLENBQW1CLEVBQW5CLENBQXVCLEdBQXhHLENBQU47Ozs7VUFHSXBDLGFBQWF3RSxHQUFHRSxTQUFILENBQWUsQ0FBZixFQUFrQlIsYUFBbEIsQ0FBbkI7UUFDSWpFLGFBQWF1RSxHQUFHRSxTQUFILENBQWUsQ0FBZixFQUFrQlIsYUFBbEIsQ0FBakI7VUFDTTdCLE9BQU9tQyxHQUFHRyxRQUFILENBQWMsQ0FBZCxFQUFpQlQsYUFBakIsQ0FBYjs7UUFFSTNCLE1BQU1pQyxHQUFHRyxRQUFILENBQWMsQ0FBZCxFQUFpQlQsYUFBakIsQ0FBVjtRQUNHOUQsYUFBSCxFQUFtQjtZQUNYb0MsS0FBS0MsR0FBTCxDQUFXLENBQVgsRUFBY0YsTUFBTSxDQUFwQixDQUFOO1NBQ0dxQyxRQUFILENBQWMsQ0FBZCxFQUFpQnJDLEdBQWpCLEVBQXNCMkIsYUFBdEI7OztVQUVJdkIsWUFBWTZCLEdBQUdLLFNBQUgsQ0FBZSxDQUFmLEVBQWtCWCxhQUFsQixDQUFsQjtVQUNNcEUsT0FBTyxFQUFJdUMsSUFBSixFQUFVRSxHQUFWLEVBQWVJLFNBQWYsRUFBYjs7UUFFRyxNQUFNQSxTQUFULEVBQXFCO2FBQ1YsRUFBQzdDLElBQUQsRUFBT0UsVUFBUCxFQUFtQkMsVUFBbkIsRUFBK0JGLGdCQUFnQjRCLHlCQUEvQyxFQUFUO0tBREYsTUFFSyxJQUFHQyw0QkFBMEI5QyxJQUFJK0IsVUFBakMsRUFBOEM7YUFDMUMsSUFBUCxDQURpRDtLQUE5QyxNQUVBO2FBQ0VnQyxTQUFMLEdBQWlCMkIsR0FBR0ssU0FBSCxDQUFlLEVBQWYsRUFBbUJYLGFBQW5CLENBQWpCO2VBQ1MsRUFBQ3BFLElBQUQsRUFBT0UsVUFBUCxFQUFtQkMsVUFBbkIsRUFBK0JGLGdCQUFnQjZCLHlCQUEvQyxFQUFUOzs7O1dBR0twQyxXQUFULENBQXFCLEdBQUdGLElBQXhCLEVBQThCO1FBQ3hCLEVBQUMrQyxJQUFELEVBQU9FLEdBQVAsRUFBWUksU0FBWixFQUF1QkUsU0FBdkIsRUFBa0NDLE1BQWxDLEVBQTBDQyxJQUExQyxLQUFrRDdELE9BQU9DLE1BQVAsQ0FBZ0IsRUFBaEIsRUFBb0IsR0FBR0csSUFBdkIsQ0FBdEQ7YUFDU3FCLFNBQVNtQyxNQUFULEVBQWlCLFFBQWpCLENBQVQ7V0FDT25DLFNBQVNvQyxJQUFULEVBQWUsTUFBZixDQUFQOztVQUVNQyxrQkFBa0JMLFlBQ3BCZix5QkFEb0IsR0FFcEJELHlCQUZKO1VBR01SLE1BQU02QixrQkFBa0JGLE9BQU9qQyxVQUF6QixHQUFzQ2tDLEtBQUtsQyxVQUF2RDtRQUNHTSxNQUFNLE1BQVQsRUFBa0I7WUFBTyxJQUFJZ0IsS0FBSixDQUFhLGtCQUFiLENBQU47OztVQUViMkMsUUFBUSxJQUFJQyxXQUFKLENBQWdCNUQsR0FBaEIsQ0FBZDs7VUFFTXFELEtBQUssSUFBSUMsUUFBSixDQUFlSyxLQUFmLEVBQXNCLENBQXRCLEVBQXlCOUIsZUFBekIsQ0FBWDtPQUNHZ0MsU0FBSCxDQUFnQixDQUFoQixFQUFtQnRELFdBQW5CLEVBQThCd0MsYUFBOUI7T0FDR2MsU0FBSCxDQUFnQixDQUFoQixFQUFtQjdELEdBQW5CLEVBQXdCK0MsYUFBeEI7T0FDR2MsU0FBSCxDQUFnQixDQUFoQixFQUFtQmxDLE9BQU9qQyxVQUExQixFQUFzQ3FELGFBQXRDO09BQ0dVLFFBQUgsQ0FBZ0IsQ0FBaEIsRUFBbUJ2QyxRQUFRLENBQTNCLEVBQThCNkIsYUFBOUI7T0FDR1UsUUFBSCxDQUFnQixDQUFoQixFQUFtQnJDLE9BQU9WLGFBQTFCLEVBQXVDcUMsYUFBdkM7UUFDRyxDQUFFdkIsU0FBTCxFQUFpQjtTQUNac0MsU0FBSCxDQUFnQixDQUFoQixFQUFtQixDQUFuQixFQUFzQmYsYUFBdEI7VUFDR3JCLFNBQUgsRUFBZTtjQUNQLElBQUlWLEtBQUosQ0FBYSxzQ0FBYixDQUFOOztLQUhKLE1BSUs7U0FDQThDLFNBQUgsQ0FBZ0IsQ0FBaEIsRUFBbUJ0QyxTQUFuQixFQUE4QnVCLGFBQTlCO1NBQ0dlLFNBQUgsQ0FBZSxFQUFmLEVBQW1CcEMsYUFBYSxDQUFoQyxFQUFtQ3FCLGFBQW5DOzs7VUFFSWdCLEtBQUssSUFBSUMsVUFBSixDQUFlTCxLQUFmLENBQVg7T0FDR00sR0FBSCxDQUFTLElBQUlELFVBQUosQ0FBZXJDLE1BQWYsQ0FBVCxFQUFpQ0UsZUFBakM7T0FDR29DLEdBQUgsQ0FBUyxJQUFJRCxVQUFKLENBQWVwQyxJQUFmLENBQVQsRUFBK0JDLGtCQUFrQkYsT0FBT2pDLFVBQXhEO1dBQ09pRSxLQUFQOzs7V0FHT3ZCLE1BQVQsQ0FBZ0JDLEVBQWhCLEVBQW9CekUsTUFBcEIsRUFBNEI7VUFDcEJELE1BQU0sSUFBSWlHLFdBQUosQ0FBZ0IsQ0FBaEIsQ0FBWjtRQUNJTixRQUFKLENBQWEzRixHQUFiLEVBQWtCbUcsU0FBbEIsQ0FBOEJsRyxVQUFRLENBQXRDLEVBQXlDeUUsRUFBekMsRUFBNkNVLGFBQTdDO1dBQ09wRixHQUFQOztXQUNPRSxRQUFULENBQWtCRixHQUFsQixFQUF1QkMsTUFBdkIsRUFBK0I7VUFDdkJ5RixLQUFLLElBQUlDLFFBQUosQ0FBZTlELFNBQVM3QixHQUFULENBQWYsQ0FBWDtXQUNPMEYsR0FBR0ssU0FBSCxDQUFlOUYsVUFBUSxDQUF2QixFQUEwQm1GLGFBQTFCLENBQVA7OztXQUVPbkMsU0FBVCxDQUFtQjBCLEdBQW5CLEVBQXdCO1VBQ2hCNEIsS0FBSyxJQUFJakIsYUFBSixDQUFrQixPQUFsQixDQUFYO1dBQ09pQixHQUFHQyxNQUFILENBQVU3QixJQUFJckIsUUFBSixFQUFWLEVBQTBCbUQsTUFBakM7O1dBQ092RCxXQUFULENBQXFCbEQsR0FBckIsRUFBMEI7VUFDbEIwRyxLQUFLLElBQUlsQixhQUFKLENBQWtCLE9BQWxCLENBQVg7V0FDT2tCLEdBQUdDLE1BQUgsQ0FBWTlFLFNBQVc3QixHQUFYLENBQVosQ0FBUDs7O1dBR082QixRQUFULENBQWtCN0IsR0FBbEIsRUFBdUI7UUFDbEIsU0FBU0EsR0FBVCxJQUFnQmtDLGNBQWNsQyxHQUFqQyxFQUF1QzthQUM5QixJQUFJaUcsV0FBSixDQUFnQixDQUFoQixDQUFQOzs7UUFFQy9ELGNBQWNsQyxJQUFJK0IsVUFBckIsRUFBa0M7VUFDN0JHLGNBQWNsQyxJQUFJeUcsTUFBckIsRUFBOEI7ZUFDckJ6RyxHQUFQOzs7VUFFQ2lHLFlBQVlXLE1BQVosQ0FBbUI1RyxHQUFuQixDQUFILEVBQTZCO2VBQ3BCQSxJQUFJeUcsTUFBWDs7O1VBRUMsZUFBZSxPQUFPekcsSUFBSThELFlBQTdCLEVBQTRDO2VBQ25DdUMsV0FBV3pCLElBQVgsQ0FBZ0I1RSxHQUFoQixFQUFxQnlHLE1BQTVCLENBRDBDO09BRzVDLE9BQU96RyxHQUFQOzs7UUFFQyxhQUFhLE9BQU9BLEdBQXZCLEVBQTZCO2FBQ3BCaUQsVUFBVWpELEdBQVYsQ0FBUDs7O1FBRUM4RSxNQUFNQyxPQUFOLENBQWMvRSxHQUFkLENBQUgsRUFBd0I7VUFDbkJnRixPQUFPQyxhQUFQLENBQXVCakYsSUFBSSxDQUFKLENBQXZCLENBQUgsRUFBbUM7ZUFDMUJxRyxXQUFXekIsSUFBWCxDQUFnQjVFLEdBQWhCLEVBQXFCeUcsTUFBNUI7O2FBQ0tqQyxPQUFTeEUsSUFBSWtGLEdBQUosQ0FBVXJELFFBQVYsQ0FBVCxDQUFQOzs7O1dBR0tPLGFBQVQsQ0FBdUIrQyxHQUF2QixFQUE0QjlDLEdBQTVCLEVBQWlDO1FBQzVCLE1BQU04QyxJQUFJaEQsTUFBYixFQUFzQjthQUFRZ0QsSUFBSSxDQUFKLENBQVA7O1FBQ3BCLE1BQU1BLElBQUloRCxNQUFiLEVBQXNCO2FBQVEsSUFBSThELFdBQUosQ0FBZ0IsQ0FBaEIsQ0FBUDs7O1FBRXBCLFFBQVE1RCxHQUFYLEVBQWlCO1lBQ1QsQ0FBTjtXQUNJLE1BQU13RSxHQUFWLElBQWlCMUIsR0FBakIsRUFBdUI7ZUFDZDBCLElBQUk5RSxVQUFYOzs7O1VBRUVxRSxLQUFLLElBQUlDLFVBQUosQ0FBZWhFLEdBQWYsQ0FBWDtRQUNJcEMsU0FBUyxDQUFiO1NBQ0ksTUFBTTRHLEdBQVYsSUFBaUIxQixHQUFqQixFQUF1QjtTQUNsQm1CLEdBQUgsQ0FBUyxJQUFJRCxVQUFKLENBQWVRLEdBQWYsQ0FBVCxFQUE4QjVHLE1BQTlCO2dCQUNVNEcsSUFBSTlFLFVBQWQ7O1dBQ0txRSxHQUFHSyxNQUFWOzs7O0FDMUpXLFNBQVNLLGtCQUFULENBQTRCLEdBQUd0RyxJQUEvQixFQUFxQztTQUMzQ3dDLHlCQUF5QixHQUFHeEMsSUFBNUIsQ0FBUDs7O0FBRUZKLE9BQU9DLE1BQVAsQ0FBZ0J5RyxrQkFBaEIsRUFBb0M7bUJBQUE7MEJBQUE7NEJBQUEsRUFBcEM7Ozs7In0=
