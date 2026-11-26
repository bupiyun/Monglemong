/** Original sprite image bytes live in IndexedDB; game saves hold only sheet IDs. */
export const SPRITE_SHEET_WIDTH = 1536;
export const SPRITE_SHEET_HEIGHT = 2400;
export const MAX_SPRITE_BYTES = 20 * 1024 * 1024;

const DATABASE_NAME = 'mori-sprite-sheets';
const DATABASE_VERSION = 1;
const STORE_NAME = 'sheets';
const SHEET_ID = /^custom_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validatedBlobs = new WeakSet();

function assertSheetId(sheetId) {
  if (typeof sheetId !== 'string' || !SHEET_ID.test(sheetId)) {
    throw new Error('스프라이트 식별자가 올바르지 않아요. 캐릭터 등록을 다시 시도해 주세요.');
  }
}

function imageType(bytes) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  return null;
}

async function decodedDimensions(blob) {
  if (typeof globalThis.createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('Image decoding failed'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Validate actual bytes and decoded dimensions; never convert frames or base64-encode. */
export async function validateSpriteFile(file) {
  if (!(file instanceof Blob)) throw new Error('업로드할 이미지 파일을 선택해 주세요.');
  if (file.size === 0) throw new Error('빈 파일은 사용할 수 없어요. 스프라이트 이미지를 다시 선택해 주세요.');
  if (file.size > MAX_SPRITE_BYTES) throw new Error('스프라이트 이미지는 20MiB 이하로 올려 주세요.');
  let mime;
  try {
    mime = imageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  } catch (cause) {
    throw new Error('이미지 파일을 읽을 수 없어요. 파일이 이동되거나 삭제되지 않았는지 확인해 주세요.', { cause });
  }
  if (!mime) throw new Error('PNG, WebP 또는 JPEG 이미지 파일만 사용할 수 있어요.');
  // Some file pickers omit or mislabel MIME types. Keep every byte and normalize
  // the type using the verified signature so object URLs decode consistently.
  const blob = file.type === mime ? file : file.slice(0, file.size, mime);
  let dimensions;
  try {
    dimensions = await decodedDimensions(blob);
  } catch (cause) {
    throw new Error('이미지를 읽을 수 없어요. 파일이 손상되지 않았는지 확인하고 PNG, WebP 또는 JPEG로 다시 저장해 주세요.', { cause });
  }
  if (dimensions.width !== SPRITE_SHEET_WIDTH || dimensions.height !== SPRITE_SHEET_HEIGHT) {
    throw new Error(`스프라이트 시트는 ${SPRITE_SHEET_WIDTH} × ${SPRITE_SHEET_HEIGHT}픽셀이어야 해요. 선택한 이미지: ${dimensions.width} × ${dimensions.height}픽셀.`);
  }
  validatedBlobs.add(blob);
  const fileName = typeof file.name === 'string' && file.name ? file.name : `sprite-sheet.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`;
  return { ...dimensions, blob, fileName };
}

function storageError(operation, cause) {
  const explanations = {
    QuotaExceededError: '기기 저장 공간이 부족해 이미지를 저장하지 못했어요. 공간을 확보한 뒤 다시 시도해 주세요.',
    SecurityError: '이 환경에서는 이미지 저장소를 사용할 수 없어요. 일반 브라우저 창이나 설치된 몽글몽 앱에서 다시 시도해 주세요.',
    NotAllowedError: '이미지 저장 권한이 허용되지 않았어요. 브라우저의 사이트 데이터 설정을 확인해 주세요.',
    VersionError: '더 새 버전의 이미지 저장소가 있어요. 최신 몽글몽 앱으로 다시 열어 주세요.',
    InvalidStateError: '이미지 저장소를 사용할 수 없는 상태예요. 게임을 다시 열고 시도해 주세요.',
    AbortError: '이미지 저장소 작업이 중단되었어요. 다시 시도해 주세요.',
  };
  return new Error(explanations[cause?.name] || `스프라이트 이미지를 ${operation} 못했어요. 기기의 저장 공간을 확인하고 게임을 다시 열어 주세요.`, { cause });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    try {
      if (!globalThis.indexedDB) throw new DOMException('IndexedDB unavailable', 'SecurityError');
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (cause) {
      reject(storageError('불러오지', cause));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      if (settled) {
        transaction.addEventListener('abort', () => database.close(), { once: true });
        transaction.abort();
        return;
      }
      try {
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      } catch (cause) {
        settled = true;
        transaction.addEventListener('abort', () => database.close(), { once: true });
        try { transaction.abort(); } catch { database.close(); }
        reject(storageError('준비하지', cause));
      }
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('다른 몽글몽 창이 이미지 저장소를 사용 중이에요. 다른 창을 닫고 다시 시도해 주세요.'));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(storageError('불러오지', request.error));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function transact(mode, operation, requestForStore) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction;
    let requestError;
    let value;
    let settled = false;
    function finish(cause) {
      if (settled) return;
      settled = true;
      database.close();
      if (cause) reject(storageError(operation, cause));
      else resolve(value);
    }
    try {
      transaction = database.transaction(STORE_NAME, mode);
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(requestError || transaction.error || new DOMException('Transaction aborted', 'AbortError'));
      transaction.onerror = event => { requestError ||= transaction.error || event.target?.error; };
      const request = requestForStore(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => { requestError = request.error; };
    } catch (cause) {
      if (transaction) {
        // Preserve the original error (for example quota exhaustion) and close
        // only after the aborted transaction has actually settled.
        requestError = cause;
        try { transaction.abort(); } catch { finish(cause); }
      } else finish(cause);
    }
  });
}

/** Resolves after commit, so callers can safely add sheetId to game metadata. */
export async function putSpriteSheet(sheetId, blob) {
  assertSheetId(sheetId);
  const original = validatedBlobs.has(blob) ? blob : (await validateSpriteFile(blob)).blob;
  await transact('readwrite', '저장하지', store => store.put(original, sheetId));
}

export async function getSpriteSheet(sheetId) {
  assertSheetId(sheetId);
  const blob = await transact('readonly', '불러오지', store => store.get(sheetId));
  if (blob === undefined) return null;
  if (!(blob instanceof Blob)) throw new Error('저장된 스프라이트 이미지가 올바르지 않아요. 원본 시트를 다시 등록해 주세요.');
  return blob;
}

export async function deleteSpriteSheet(sheetId) {
  assertSheetId(sheetId);
  await transact('readwrite', '삭제하지', store => store.delete(sheetId));
}
