// QR Code generator (MIT, Kazuhiko Arase) for the receive window.
// Bundled separately from the crypto primitives: it is only needed when
// an address is shown, and it has no dependencies.
import qrcode from 'qrcode-generator';

export default qrcode;
