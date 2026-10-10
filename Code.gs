/**
 * Tarachand MV School — Google Apps Script backend
 *
 * Configure MASTER_FOLDER_ID with a Drive folder ID to manage folders inside
 * that folder. Leave it empty to use the My Drive root.
 *
 * Small files use uploadFile (Base64 JSON). Files over 10 MiB use the
 * resumable Drive API actions startUpload + uploadChunk. Those chunk requests
 * keep each Apps Script request small while supporting files up to 100 MiB.
 */

var MASTER_FOLDER_ID = '1mQkLAZDNOLSgqZ01Dwqe2TVo6c603m8n';
var MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB maximum file size.
var MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024; // Single-request DriveApp path.
var MAX_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MiB; a multiple of Drive's 256 KiB alignment.
var DRIVE_CHUNK_GRANULARITY = 256 * 1024;
var MAX_FOLDER_NAME_LENGTH = 120;
var MAX_FILE_NAME_LENGTH = 255;
var UPLOAD_STATE_PREFIX = 'TARACHAND_MV_UPLOAD_';
var UPLOAD_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Health check for the deployed Web App. */
function doGet(e) {
  try {
    var parent = getManagedParentFolder_();
    return jsonOutput_({
      status: 'success',
      service: 'Tarachand MV School',
      message: 'The web app is healthy.',
      managedFolderName: parent.getName(),
      actions: ['listFolders', 'listFiles', 'createFolder', 'uploadFile', 'startUpload', 'uploadChunk']
    });
  } catch (error) {
    logError_(error);
    return jsonOutput_({ status: 'error', message: errorMessage_(error) });
  }
}

/** JSON API endpoint. Requests from index.html use Content-Type: text/plain. */
function doPost(e) {
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string' || !e.postData.contents.trim()) {
      throw new Error('The request body is empty. Send a JSON body with Content-Type: text/plain.');
    }

    var request;
    try {
      request = JSON.parse(e.postData.contents);
    } catch (parseError) {
      throw new Error('The request body must be valid JSON.');
    }

    if (!request || Object.prototype.toString.call(request) !== '[object Object]') {
      throw new Error('The request body must be a JSON object.');
    }

    switch (String(request.action || '')) {
      case 'listFolders':
        return jsonOutput_(listFolders_());
      case 'listFiles':
        return jsonOutput_(listFiles_(request));
      case 'createFolder':
        return jsonOutput_(createFolder_(request));
      case 'uploadFile':
        return jsonOutput_(uploadFile_(request));
      case 'startUpload':
        return jsonOutput_(startUpload_(request));
      case 'uploadChunk':
        return jsonOutput_(uploadChunk_(request));
      default:
        throw new Error('Unknown action. Use listFolders, listFiles, createFolder, uploadFile, startUpload, or uploadChunk.');
    }
  } catch (error) {
    logError_(error);
    return jsonOutput_({ status: 'error', message: errorMessage_(error) });
  }
}

/**
 * Run once from the Apps Script editor to authorize Drive and UrlFetch access.
 * The Drive API service must be enabled for this project for >10 MiB uploads.
 */
function authorizeDrive() {
  try {
    var root = DriveApp.getRootFolder();
    var managedParent = getManagedParentFolder_();
    managedParent.getFolders().hasNext();

    var response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      throw new Error(driveApiErrorMessage_(response, 'authorization check'));
    }

    var result = {
      status: 'success',
      message: 'Google Drive and resumable-upload authorization are ready.',
      rootFolderId: root.getId(),
      managedFolderId: managedParent.getId(),
      managedFolderName: managedParent.getName()
    };
    Logger.log(JSON.stringify(result));
    return result;
  } catch (error) {
    logError_(error);
    throw new Error('Drive authorization/setup failed: ' + errorMessage_(error));
  }
}

/** Return every folder under the configured Drive location as a sorted tree list. */
function listFolders_() {
  var root = getManagedParentFolder_();
  var folders = [];
  var visited = Object.create(null);
  var stack = [{ folder: root, path: '', depth: -1 }];

  while (stack.length) {
    var current = stack.pop();
    var iterator = current.folder.getFolders();
    var children = [];
    while (iterator.hasNext()) children.push(iterator.next());

    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var childId = child.getId();
      if (visited[childId]) continue;
      visited[childId] = true;
      var childName = child.getName();
      var childPath = current.path ? current.path + ' / ' + childName : childName;
      folders.push({
        id: childId,
        name: childName,
        parentId: current.folder.getId(),
        path: childPath,
        depth: current.depth + 1
      });
      stack.push({ folder: child, path: childPath, depth: current.depth + 1 });
    }
  }

  folders.sort(function (a, b) {
    return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
  });

  return { status: 'success', folders: folders, message: 'All folders loaded.' };
}

/** List or search files in the selected folder; global search traverses all folders. */
function listFiles_(request) {
  var folderId = String(request.folderId || '').trim();
  var query = String(request.query || '').trim().toLowerCase();
  if (!folderId && query.length < 2) {
    return { status: 'success', files: [], truncated: false, needsQuery: true, message: 'Enter at least two characters to search all folders.' };
  }

  var includeSubfolders = !folderId || request.includeSubfolders === true;
  var startFolder = folderId ? getManagedChildFolder_(folderId) : getManagedParentFolder_();
  var startPath = folderId ? String(request.folderPath || startFolder.getName()).trim() : startFolder.getName();
  var stack = [{ folder: startFolder, path: startPath || startFolder.getName() }];

  var files = [];
  var visited = Object.create(null);
  var truncated = false;
  var maxResults = 500;

  while (stack.length && !truncated) {
    var current = stack.pop();
    var currentId = current.folder.getId();
    if (visited[currentId]) continue;
    visited[currentId] = true;

    var fileIterator = current.folder.getFiles();
    while (fileIterator.hasNext()) {
      var file = fileIterator.next();
      var fileName = file.getName();
      if (query && (fileName + ' ' + current.path).toLowerCase().indexOf(query) < 0) continue;
      if (files.length >= maxResults) {
        truncated = true;
        break;
      }

      var fileSize = 0;
      var updatedAt = '';
      try { fileSize = file.getSize(); } catch (sizeError) { fileSize = 0; }
      try { updatedAt = file.getLastUpdated().toISOString(); } catch (dateError) { updatedAt = ''; }
      files.push({
        id: file.getId(),
        name: fileName,
        mimeType: file.getMimeType(),
        fileUrl: file.getUrl(),
        size: fileSize,
        updatedAt: updatedAt,
        folderId: currentId,
        folderPath: current.path
      });
    }

    if (!truncated && includeSubfolders) {
      var subfolders = current.folder.getFolders();
      while (subfolders.hasNext()) {
        var subfolder = subfolders.next();
        stack.push({ folder: subfolder, path: current.path + ' / ' + subfolder.getName() });
      }
    }
  }

  files.sort(function (a, b) {
    var left = (a.folderPath + ' / ' + a.name).toLowerCase();
    var right = (b.folderPath + ' / ' + b.name).toLowerCase();
    return left.localeCompare(right);
  });

  return {
    status: 'success',
    files: files,
    truncated: truncated,
    needsQuery: false,
    message: truncated ? 'Showing the first 500 matches. Refine the search to narrow results.' : 'Files loaded.'
  };
}

/** Create a folder under the selected managed folder, or at the managed root. */
function createFolder_(request) {
  var folderName = String(request.folderName || '').trim();
  if (!folderName) throw new Error('Enter a folder name.');
  if (folderName.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error('Folder names must be ' + MAX_FOLDER_NAME_LENGTH + ' characters or fewer.');
  }
  if (/[\u0000-\u001F\u007F]/.test(folderName)) {
    throw new Error('Folder names cannot contain control characters.');
  }

  var parentFolderId = String(request.parentFolderId || '').trim();
  var parentFolder = parentFolderId ? getManagedChildFolder_(parentFolderId) : getManagedParentFolder_();
  var folder = parentFolder.createFolder(folderName);
  return {
    status: 'success',
    folder: { id: folder.getId(), name: folder.getName(), parentId: parentFolder.getId() },
    message: 'Folder created.'
  };
}

/** Legacy/small-file upload path; kept for files up to 10 MiB. */
function uploadFile_(request) {
  var folderId = String(request.folderId || '').trim();
  if (!folderId) throw new Error('Select a destination folder before uploading.');
  var folder = getManagedChildFolder_(folderId);
  var fileName = cleanFileName_(request.fileName);
  var mimeType = normalizeMimeType_(request.mimeType, fileName);
  var encodedData = cleanBase64_(request.fileData);

  if (encodedData.length > 4 * Math.ceil(MAX_DIRECT_UPLOAD_BYTES / 3)) {
    throw new Error('Single-request uploads are limited to 10 MiB. Use the chunked uploader for larger files.');
  }

  var bytes = decodeBase64_(encodedData);
  if (!bytes.length) throw new Error('The uploaded file contains no data.');
  if (bytes.length > MAX_DIRECT_UPLOAD_BYTES) {
    throw new Error('Single-request uploads are limited to 10 MiB. Use the chunked uploader for larger files.');
  }

  var createdFile = folder.createFile(Utilities.newBlob(bytes, mimeType, fileName));
  return {
    status: 'success',
    fileName: createdFile.getName(),
    fileUrl: createdFile.getUrl(),
    message: 'File uploaded.'
  };
}

/** Start a Drive API resumable upload for a file larger than 10 MiB. */
function startUpload_(request) {
  var folderId = String(request.folderId || '').trim();
  if (!folderId) throw new Error('Select a destination folder before uploading.');
  getManagedChildFolder_(folderId);

  var fileName = cleanFileName_(request.fileName);
  var mimeType = normalizeMimeType_(request.mimeType, fileName);
  var fileSize = Number(request.fileSize);
  if (!isFinite(fileSize) || Math.floor(fileSize) !== fileSize || fileSize < 1) {
    throw new Error('The file size is missing or invalid.');
  }
  if (fileSize > MAX_UPLOAD_BYTES) {
    throw new Error('Files must be 100 MiB or smaller.');
  }

  cleanupExpiredUploadStates_();

  var endpoint = 'https://www.googleapis.com/upload/drive/v3/files' +
    '?uploadType=resumable&supportsAllDrives=true&fields=id%2Cname%2CwebViewLink';
  var metadata = { name: fileName, mimeType: mimeType, parents: [folderId] };
  var response;
  try {
    response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify(metadata),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(fileSize)
      },
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (error) {
    throw new Error('Could not start a Google Drive resumable upload: ' + errorMessage_(error));
  }

  var responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(driveApiErrorMessage_(response, 'session creation'));
  }

  var sessionUrl = responseHeader_(response, 'Location');
  if (!sessionUrl || !/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(sessionUrl)) {
    throw new Error('Google Drive did not return a valid resumable upload session.');
  }

  var uploadId = Utilities.getUuid();
  var state = {
    uploadId: uploadId,
    sessionUrl: sessionUrl,
    folderId: folderId,
    fileName: fileName,
    mimeType: mimeType,
    fileSize: fileSize,
    nextOffset: 0,
    createdAt: Date.now(),
    complete: false
  };
  saveUploadState_(state);

  return {
    status: 'success',
    uploadId: uploadId,
    chunkSize: MAX_CHUNK_BYTES,
    message: 'Resumable upload started.'
  };
}

/** Receive one Base64 chunk and forward it to the stored Drive upload session. */
function uploadChunk_(request) {
  var uploadId = String(request.uploadId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error('The upload session ID is invalid. Start the upload again.');

  var offset = Number(request.offset);
  if (!isFinite(offset) || Math.floor(offset) !== offset || offset < 0) {
    throw new Error('The chunk offset is invalid.');
  }

  var encodedData = cleanBase64_(request.fileData);
  if (encodedData.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)) {
    throw new Error('A transfer chunk is too large.');
  }
  var bytes = decodeBase64_(encodedData);
  if (!bytes.length || bytes.length > MAX_CHUNK_BYTES) throw new Error('The transfer chunk is empty or too large.');

  var state = getUploadState_(uploadId);
  if (state.complete) return completedUploadResponse_(state);

  // If a previous response was lost, acknowledge the already-stored bytes.
  if (offset < state.nextOffset) {
    return { status: 'success', complete: false, nextOffset: state.nextOffset, totalBytes: state.fileSize };
  }
  if (offset !== state.nextOffset) {
    throw new Error('Upload is out of sequence. Expected byte ' + state.nextOffset + '.');
  }
  if (offset + bytes.length > state.fileSize) throw new Error('The chunk extends beyond the declared file size.');
  var endExclusive = offset + bytes.length;
  if (endExclusive < state.fileSize && bytes.length % DRIVE_CHUNK_GRANULARITY !== 0) {
    throw new Error('Non-final chunks must be a multiple of 256 KiB.');
  }

  var response;
  try {
    response = UrlFetchApp.fetch(state.sessionUrl, {
      method: 'put',
      contentType: state.mimeType,
      payload: bytes,
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'Content-Range': 'bytes ' + offset + '-' + (endExclusive - 1) + '/' + state.fileSize
      },
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (error) {
    throw new Error('Google Drive did not confirm this upload chunk. Retry the upload; already received chunks are retained. ' + errorMessage_(error));
  }

  var responseCode = response.getResponseCode();
  if (responseCode === 308) {
    var nextOffset = acceptedOffsetFromRange_(responseHeader_(response, 'Range'));
    if (nextOffset === null) nextOffset = offset;
    if (nextOffset <= offset) {
      throw new Error('Google Drive did not confirm receipt of the chunk. Retry the upload.');
    }
    if (nextOffset > endExclusive || nextOffset > state.fileSize) {
      throw new Error('Google Drive returned an unexpected upload offset. Start the upload again.');
    }
    state.nextOffset = nextOffset;
    saveUploadState_(state);
    return { status: 'success', complete: false, nextOffset: nextOffset, totalBytes: state.fileSize };
  }

  if (responseCode === 200 || responseCode === 201) {
    var fileMetadata = parseDriveResponse_(response, 'file completion');
    state.nextOffset = state.fileSize;
    state.complete = true;
    state.fileId = String(fileMetadata.id || '');
    state.fileName = String(fileMetadata.name || state.fileName);
    state.fileUrl = String(fileMetadata.webViewLink || (state.fileId ? 'https://drive.google.com/open?id=' + encodeURIComponent(state.fileId) : ''));
    state.completedAt = Date.now();
    saveUploadState_(state);
    return completedUploadResponse_(state);
  }

  if (responseCode === 404) {
    deleteUploadState_(uploadId);
    throw new Error('The Google Drive upload session expired. Start the upload again.');
  }
  throw new Error(driveApiErrorMessage_(response, 'chunk upload'));
}

/** Use a configured master folder, or fall back to My Drive root if blank. */
function getManagedParentFolder_() {
  var configuredId = String(MASTER_FOLDER_ID || '').trim();
  return configuredId ? DriveApp.getFolderById(configuredId) : DriveApp.getRootFolder();
}

/** Restrict actions to folders inside the configured document location. */
function getManagedChildFolder_(folderId) {
  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (error) {
    throw new Error('The selected folder was not found or is not accessible.');
  }

  var managedParentId = getManagedParentFolder_().getId();
  if (folder.getId() === managedParentId) {
    throw new Error('Choose a folder inside the configured document location.');
  }

  var stack = [folder];
  var visited = Object.create(null);
  while (stack.length) {
    var current = stack.pop();
    var currentId = current.getId();
    if (currentId === managedParentId) return folder;
    if (visited[currentId]) continue;
    visited[currentId] = true;
    var parents = current.getParents();
    while (parents.hasNext()) stack.push(parents.next());
  }

  throw new Error('The selected folder is outside the configured document location. Refresh the folder list and try again.');
}

function cleanFileName_(value) {
  var fileName = String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '');
  if (!fileName) throw new Error('The uploaded file must have a name.');
  if (fileName.length > MAX_FILE_NAME_LENGTH) {
    throw new Error('File names must be ' + MAX_FILE_NAME_LENGTH + ' characters or fewer.');
  }
  return fileName;
}

function normalizeMimeType_(value, fileName) {
  var mimeType = String(value || '').trim().toLowerCase().split(';')[0];
  if (!mimeType || mimeType === 'application/octet-stream') mimeType = inferMimeType_(fileName);
  var isPdf = mimeType === 'application/pdf';
  var isImage = /^image\/[a-z0-9.+-]+$/.test(mimeType);
  if (!isPdf && !isImage) throw new Error('Only image files and PDF documents can be uploaded.');
  return mimeType;
}

function inferMimeType_(fileName) {
  var match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return '';
  var types = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif'
  };
  return types[match[1]] || '';
}

function cleanBase64_(value) {
  var encodedData = String(value || '').trim();
  if (/^data:/i.test(encodedData)) {
    var commaIndex = encodedData.indexOf(',');
    if (commaIndex < 0) throw new Error('The uploaded file data URL is malformed.');
    encodedData = encodedData.substring(commaIndex + 1);
  }
  encodedData = encodedData.replace(/\s/g, '');
  if (!encodedData) throw new Error('The uploaded file contains no data.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encodedData)) throw new Error('The uploaded file data is not valid Base64.');
  return encodedData;
}

function decodeBase64_(encodedData) {
  try {
    return Utilities.base64Decode(encodedData);
  } catch (error) {
    throw new Error('The uploaded file data could not be decoded.');
  }
}

function saveUploadState_(state) {
  PropertiesService.getScriptProperties().setProperty(UPLOAD_STATE_PREFIX + state.uploadId, JSON.stringify(state));
}

function getUploadState_(uploadId) {
  var properties = PropertiesService.getScriptProperties();
  var key = UPLOAD_STATE_PREFIX + uploadId;
  var raw = properties.getProperty(key);
  if (!raw) throw new Error('The upload session was not found or expired. Start the upload again.');

  var state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    properties.deleteProperty(key);
    throw new Error('The upload session is invalid. Start the upload again.');
  }
  if (!state.createdAt || Date.now() - state.createdAt > UPLOAD_STATE_TTL_MS) {
    properties.deleteProperty(key);
    throw new Error('The upload session expired. Start the upload again.');
  }
  return state;
}

function deleteUploadState_(uploadId) {
  PropertiesService.getScriptProperties().deleteProperty(UPLOAD_STATE_PREFIX + uploadId);
}

function cleanupExpiredUploadStates_() {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(UPLOAD_STATE_PREFIX) !== 0) return;
    try {
      var state = JSON.parse(all[key]);
      if (!state.createdAt || now - state.createdAt > UPLOAD_STATE_TTL_MS) properties.deleteProperty(key);
    } catch (error) {
      properties.deleteProperty(key);
    }
  });
}

function completedUploadResponse_(state) {
  return {
    status: 'success',
    complete: true,
    uploadId: state.uploadId,
    nextOffset: state.fileSize,
    totalBytes: state.fileSize,
    fileName: state.fileName,
    fileUrl: state.fileUrl,
    message: 'File uploaded.'
  };
}

function responseHeader_(response, headerName) {
  var headers = response.getHeaders();
  var expected = String(headerName).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === expected) {
      var value = headers[keys[i]];
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }
  return '';
}

function acceptedOffsetFromRange_(rangeHeader) {
  var match = String(rangeHeader || '').match(/bytes\s*=\s*\d+-(\d+)/i);
  return match ? Number(match[1]) + 1 : null;
}

function parseDriveResponse_(response, operation) {
  var text = response.getContentText();
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    throw new Error('Google Drive returned an unreadable response during ' + operation + '.');
  }
}

function driveApiErrorMessage_(response, operation) {
  var code = response.getResponseCode();
  var raw = response.getContentText() || '';
  var message = raw;
  try {
    var parsed = JSON.parse(raw);
    if (parsed && parsed.error) message = parsed.error.message || JSON.stringify(parsed.error);
  } catch (error) {
    // Keep the plain response text when it is not JSON.
  }
  if (!message) message = 'No error details were returned.';
  if (code === 403 && /accessNotConfigured|has not been used|disabled/i.test(raw)) {
    message += ' Enable the Google Drive API in this Apps Script project and run authorizeDrive again.';
  }
  return 'Google Drive ' + operation + ' failed (' + code + '): ' + message;
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function errorMessage_(error) {
  return error && error.message ? String(error.message) : String(error || 'Unknown error.');
}

function logError_(error) {
  Logger.log('Tarachand MV School error: ' + errorMessage_(error));
}
