// receiptObject (#152): a picked receipt's key and content type come from what
// the picker says the file is, never from the tail of its URI. On web and in
// Electron that URI is a blob: object URL, and useReceiptPhoto used to take
// everything after its last dot as the "extension": the whole URL on
// localhost, `1:49217/<uuid>` in Electron, `app/<uuid>` on a deployed host.
// The URIs below are the shapes each platform's expo-image-picker returns
// (17.0.11): web's object URL, iOS's and Android's cached file:// copy, and a
// PhotoKit ph:// and a data: URI, which it does not return but which must not
// yield garbage either. On web the picker also returns a video when the file
// dialog is switched to other files: it keeps its own type, under `bin`.
//
// This module is new with #152, so this suite cannot load on the code before
// it. Its regression tests were proven red under the mutant that builds the
// key the old way (`uri.split('.').pop() ?? 'jpg'`, typed `image/${ext}`),
// and each other test under the mutant named in its title's comment.

import {
  receiptObject,
  UNKNOWN_EXTENSION,
  UNKNOWN_TYPE,
  type ReceiptPhoto,
} from '../receiptObject';

const USER = '3f1c2b9a-6d1e-4c1b-9d7e-2a1b3c4d5e6f';
const TXN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const WEB = 'blob:http://localhost:8081/0b7f2a8e-4d7c-4c55-9a0e-1f6c1d2e3f40';
const DEPLOYED =
  'blob:https://nestworth.app/0b7f2a8e-4d7c-4c55-9a0e-1f6c1d2e3f40';
const ELECTRON =
  'blob:http://127.0.0.1:49217/0b7f2a8e-4d7c-4c55-9a0e-1f6c1d2e3f40';
const IOS =
  'file:///var/mobile/Containers/Data/Application/0A1B/Library/Caches/ImagePicker/5C0E2B4A-9D3F-4E1A-8B7C-6D5E4F3A2B1C.jpg';
const ANDROID =
  'file:///data/user/0/app.nestworth/cache/ImagePicker/1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b.jpeg';

function key(photo: ReceiptPhoto) {
  return receiptObject(USER, TXN, photo);
}

describe('receiptObject: the key and type come from the picked asset (#152)', () => {
  it('web: keys a photo by its type, not by the tail of its blob: URL', () => {
    expect(
      key({ uri: WEB, mimeType: 'image/png', fileName: 'receipt.png' })
    ).toEqual({
      path: `${USER}/${TXN}.png`,
      contentType: 'image/png',
    });
    expect(
      key({ uri: DEPLOYED, mimeType: 'image/jpeg', fileName: 'IMG_0001.jpg' })
    ).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
    expect(
      key({ uri: ELECTRON, mimeType: 'image/heic', fileName: 'IMG_0002.HEIC' })
    ).toEqual({
      path: `${USER}/${TXN}.heic`,
      contentType: 'image/heic',
    });
  });

  it('web: the type wins over a file name that says otherwise (mutant: the name consulted first)', () => {
    expect(
      key({ uri: WEB, mimeType: 'image/jpeg', fileName: 'scan.png' })
    ).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
  });

  it('web: a type with no file name is enough (mutant: the type ignored)', () => {
    expect(key({ uri: WEB, mimeType: 'image/webp', fileName: null })).toEqual({
      path: `${USER}/${TXN}.webp`,
      contentType: 'image/webp',
    });
  });

  it('iOS keeps the key it had (the cached .jpg: a pin), and its type is now image/jpeg, not image/jpg', () => {
    expect(key({ uri: IOS, mimeType: 'image/jpeg', fileName: null })).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
  });

  it("Android's .jpeg copy is stored as .jpg, one extension per type (mutant: the jpeg alias dropped)", () => {
    expect(
      key({ uri: ANDROID, mimeType: 'image/jpeg', fileName: null })
    ).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
    expect(key({ uri: ANDROID, mimeType: null, fileName: null })).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
  });

  it('reads a type in any case, with parameters, and the nonstandard image/jpg as image/jpeg', () => {
    expect(key({ uri: WEB, mimeType: 'Image/HEIF' })).toEqual({
      path: `${USER}/${TXN}.heif`,
      contentType: 'image/heif',
    });
    expect(key({ uri: WEB, mimeType: 'image/jpeg; charset=binary' })).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
    expect(key({ uri: WEB, mimeType: 'image/jpg' })).toEqual({
      path: `${USER}/${TXN}.jpg`,
      contentType: 'image/jpeg',
    });
  });

  it('reads a type with white space around it (mutant: the type not trimmed)', () => {
    expect(key({ uri: WEB, mimeType: ' image/png ' })).toEqual({
      path: `${USER}/${TXN}.png`,
      contentType: 'image/png',
    });
  });

  it('a type is one type/subtype and nothing after it (mutants: the end anchor dropped, the subtype class loosened)', () => {
    const fallback = {
      path: `${USER}/${TXN}.bin`,
      contentType: 'application/octet-stream',
    };
    expect(key({ uri: WEB, mimeType: 'image/png x' })).toEqual(fallback);
    expect(key({ uri: WEB, mimeType: 'image/png/x' })).toEqual(fallback);
  });

  it('without a type, takes a known extension from the file name, then from the URI (mutants: either ignored)', () => {
    expect(key({ uri: WEB, fileName: 'Receipt.PNG' })).toEqual({
      path: `${USER}/${TXN}.png`,
      contentType: 'image/png',
    });
    expect(
      key({ uri: 'file:///tmp/cache/a1b2.gif?v=2#top', mimeType: '' })
    ).toEqual({
      path: `${USER}/${TXN}.gif`,
      contentType: 'image/gif',
    });
    // The extension is after the name's last dot, not its first.
    expect(key({ uri: WEB, fileName: 'IMG_0001.edited.png' })).toEqual({
      path: `${USER}/${TXN}.png`,
      contentType: 'image/png',
    });
  });

  it('without a type, the file name wins over the URI (mutant: the URI consulted first)', () => {
    expect(
      key({ uri: 'file:///tmp/cache/a1b2.gif', fileName: 'Receipt.png' })
    ).toEqual({
      path: `${USER}/${TXN}.png`,
      contentType: 'image/png',
    });
  });

  it('without a type, reads each known image extension of a name (mutants: heic, heif or webp dropped from the table)', () => {
    expect(key({ uri: WEB, fileName: 'IMG_0003.HEIC' })).toEqual({
      path: `${USER}/${TXN}.heic`,
      contentType: 'image/heic',
    });
    expect(key({ uri: WEB, fileName: 'IMG_0004.heif' })).toEqual({
      path: `${USER}/${TXN}.heif`,
      contentType: 'image/heif',
    });
    expect(key({ uri: WEB, fileName: 'receipt.webp' })).toEqual({
      path: `${USER}/${TXN}.webp`,
      contentType: 'image/webp',
    });
  });

  it('an image of another type keeps its type under the unknown extension', () => {
    expect(
      key({ uri: WEB, mimeType: 'image/svg+xml', fileName: 'logo.svg' })
    ).toEqual({
      path: `${USER}/${TXN}.${UNKNOWN_EXTENSION}`,
      contentType: 'image/svg+xml',
    });
  });

  it('web: a video the file dialog let through keeps its own type under the unknown extension (mutant: only image types kept)', () => {
    // ExponentImagePicker.web.ts returns any video/* file, whatever media
    // types were asked for; `accept="image/*"` only filters the dialog.
    expect(
      key({ uri: WEB, mimeType: 'video/mp4', fileName: 'clip.mp4' })
    ).toEqual({
      path: `${USER}/${TXN}.${UNKNOWN_EXTENSION}`,
      contentType: 'video/mp4',
    });
  });

  it('never takes the tail of a blob:, ph: or data: URI, or an unknown extension: the stated fallback', () => {
    const fallback = {
      path: `${USER}/${TXN}.bin`,
      contentType: 'application/octet-stream',
    };
    expect({ UNKNOWN_EXTENSION, UNKNOWN_TYPE }).toEqual({
      UNKNOWN_EXTENSION: 'bin',
      UNKNOWN_TYPE: 'application/octet-stream',
    });
    expect(key({ uri: WEB })).toEqual(fallback);
    expect(key({ uri: DEPLOYED, mimeType: null, fileName: null })).toEqual(
      fallback
    );
    expect(
      key({ uri: 'ph://5C0E2B4A-9D3F-4E1A-8B7C-6D5E4F3A2B1C/L0/001' })
    ).toEqual(fallback);
    expect(
      key({ uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' })
    ).toEqual(fallback);
    expect(key({ uri: 'content://media/external/images/media/1234' })).toEqual(
      fallback
    );
    expect(
      key({ uri: WEB, mimeType: 'not a type', fileName: 'notes.txt' })
    ).toEqual(fallback);
    expect(
      key({ uri: WEB, mimeType: 'image/', fileName: 'archive.tar.gz' })
    ).toEqual(fallback);
    // A type is the whole string, not a well-formed tail of it.
    expect(key({ uri: WEB, mimeType: 'no image/png' })).toEqual(fallback);
  });

  it('a name whose extension is an Object.prototype key is no image (mutant: a plain object for the table)', () => {
    const fallback = {
      path: `${USER}/${TXN}.bin`,
      contentType: 'application/octet-stream',
    };
    expect(key({ uri: WEB, fileName: 'receipt.constructor' })).toEqual(
      fallback
    );
    expect(key({ uri: 'file:///tmp/x.__proto__' })).toEqual(fallback);
  });
});
