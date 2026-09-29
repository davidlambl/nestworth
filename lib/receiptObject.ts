/**
 * What a picked receipt photo is stored as in the `receipts` bucket: its key
 * and its content type, both from what the image picker says the file is
 * (#152).
 *
 * The key is `<user id>/<transaction id>.<extension>`, directly in the user's
 * folder: that is the one shape the bucket's policies admit
 * (supabase/migrations/009_receipt_storage_policies.sql). One key per
 * transaction and extension: a second photo with the same extension attached
 * to the same transaction replaces the first (useReceiptPhoto uploads with
 * `upsert: true`), and one with another extension goes to a second key and
 * leaves the first behind, for #23's "remove a receipt". Every type outside
 * the table below shares the extension `bin`.
 *
 * The type comes from the asset's `mimeType`. Only when the asset carries no
 * well-formed type are the file name and then the URI's own last path segment
 * consulted, and from either only a known image extension is read. The
 * extension always comes from the type, so the raw text after the URI's last
 * dot is never used. On web and in Electron expo-image-picker returns a
 * `blob:` object URL, which has no extension: the hook used to take
 * everything after the URI's last dot, which there is the end of the host
 * name plus the URL's UUID (`app/<uuid>`), or on a host with no dot, such as
 * localhost, the whole URL. iOS and Android return a cached file:// copy
 * whose extension matches, and a mimeType derived from it.
 *
 * A type outside the table keeps its own name under the extension `bin`. On
 * web that can be a video: the picker's file dialog offers other files, and
 * it returns any `video/*` file it is handed, whatever media types were asked
 * for.
 */

/** What the key needs from a picked photo; expo-image-picker's asset has it. */
export interface ReceiptPhoto {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
}

export interface ReceiptObject {
  /** The object's key in the `receipts` bucket. */
  path: string;
  /** Sent with the upload; Storage keeps it as the object's content type. */
  contentType: string;
}

/** The extension a receipt of each known image type is stored under. */
const EXTENSION_BY_TYPE = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

/**
 * The type each known extension stands for, other spellings included. A Map,
 * not an object literal: a name ending in `.constructor` must not find
 * Object.prototype's.
 */
const TYPE_BY_EXTENSION = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

/** The extension of a file of any other type, or of no known type. */
export const UNKNOWN_EXTENSION = 'bin';
/** The content type of a file of no known type. */
export const UNKNOWN_TYPE = 'application/octet-stream';

export function receiptObject(
  userId: string,
  transactionId: string,
  photo: ReceiptPhoto
): ReceiptObject {
  const type =
    mediaType(photo.mimeType) ??
    typeOfName(photo.fileName) ??
    typeOfName(lastSegment(photo.uri));
  const extension = (type && EXTENSION_BY_TYPE.get(type)) ?? UNKNOWN_EXTENSION;
  return {
    path: `${userId}/${transactionId}.${extension}`,
    contentType: type ?? UNKNOWN_TYPE,
  };
}

/**
 * A well-formed `type/subtype`, lowercased and without parameters, with the
 * nonstandard `image/jpg` read as `image/jpeg`; null for anything else.
 */
function mediaType(mimeType: string | null | undefined): string | null {
  const type = mimeType?.split(';')[0].trim().toLowerCase();
  if (!type || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type)) {
    return null;
  }
  return type === 'image/jpg' ? 'image/jpeg' : type;
}

/** The type a name's extension stands for, if it is a known image extension. */
function typeOfName(name: string | null | undefined): string | null {
  const dot = name ? name.lastIndexOf('.') : -1;
  if (!name || dot < 0) {
    return null;
  }
  return TYPE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** A URI's last path segment, without its query or fragment. */
function lastSegment(uri: string): string {
  const path = uri.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1);
}
