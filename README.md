# Tarachand MV School — Drive Document Manager

A single-page school document dashboard connected automatically to Google Drive through Google Apps Script. The GitHub Pages site serves `index.html`; the Apps Script Web App (`Code.gs`) performs Drive operations.

## Files

- `index.html` — responsive, dependency-free front end; the Web App URL is hardcoded in `WEB_APP_URL`, so there is no connection form.
- `Code.gs` — Google Apps Script backend. `MASTER_FOLDER_ID` is configured with the Drive folder ID supplied for Tarachand MV School.
- `DEPLOYMENT.md` — setup, deployment, GitHub Pages, and troubleshooting steps.

## Required before the site can work

The Apps Script project behind the Web App URL must have the matching `Code.gs` deployed. The latest supplied backend uses the folder ID by itself:

```js
var MASTER_FOLDER_ID = '1mQkLAZDNOLSgqZ01Dwqe2TVo6c603m8n';
```

Do not put the entire `https://drive.google.com/drive/folders/...` URL in this setting. The previously checked live deployment returned an invalid-ID error because it had the full Drive URL in `MASTER_FOLDER_ID`.

1. Paste this repository's `Code.gs` into the Apps Script project that owns the Web App URL in `index.html`.
2. Ensure that the account used by **Execute as: Me** can access the master Drive folder.
3. Enable the Google Drive API for resumable uploads and run `authorizeDrive()` once.
4. Deploy the Apps Script Web App with **Execute as: Me** and **Who has access: Anyone**, as detailed in `DEPLOYMENT.md`.
5. Redeploy a **new version**. The front end connects to the configured `/exec` URL on page load.

## Publish the front end on GitHub Pages

1. Create a GitHub repository.
2. Unzip this project and upload the files (`index.html`, `Code.gs`, `README.md`, and `DEPLOYMENT.md`) to the repository root. GitHub Pages only serves the static HTML; Apps Script runs the backend.
3. Open **Settings → Pages** in the repository. Select **Deploy from a branch**, choose `main` and `/ (root)`, then save.
4. Visit the GitHub Pages URL after the deployment finishes.

## Features and limits

- Collapsible, searchable folder tree: top-level folders appear first; click a folder to select it and expand or collapse its children. The selected folder's files load in the workspace.
- Search files within a selected folder, its nested folders, or across the managed Drive location.
- Create folders in the selected folder, or at the configured master folder if none is selected.
- Upload photos and PDFs up to **100 MiB per file**. Files over 10 MiB are transferred in 5 MiB chunks.
- Pure HTML, CSS, and vanilla JavaScript; no external frameworks or runtime assets.

## Security

The requested Apps Script access setting, **Anyone**, makes the endpoint callable by anyone who obtains its URL. The app has no sign-in layer. Do not use this public configuration for confidential student records without adding proper authentication and reviewing your school's data-protection requirements. Drive file links also do not automatically grant access to other users.
