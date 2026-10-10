# Tarachand MV School — deployment guide

The app supports image and PDF uploads up to **100 MiB per file**. Files up to 10 MiB use the simple DriveApp path; larger files are sent in 5 MiB pieces through Google's resumable Drive upload API. This chunking is necessary because a 100 MiB Base64 string cannot be sent as one Apps Script web-app request.

## 1. Prepare the Drive destination (optional)

The current `Code.gs` is configured with the master Drive folder ID you supplied. The app recursively lists folders and searches files under that location. To use a different master folder, open its Drive URL, copy only the text after `/folders/`, and put that ID between the quotes in `MASTER_FOLDER_ID`. Leave the value as `''` if you want to use the deploying account's My Drive root instead. The front page shows a searchable, collapsible tree: only top-level folders appear initially, and clicking a folder selects it and opens or closes its child folders. Creating a folder with one selected places it inside that folder; with no selection, it creates one directly under the configured location.

## 2. Create the Apps Script project and enable Drive API

1. Sign in to the Google account whose Drive should receive the files.
2. Go to [script.google.com](https://script.google.com/) and click **New project**.
3. Open the default `Code.gs`, replace its contents with the complete supplied `Code.gs`, and save the project.
4. In the Apps Script editor, open **Services** in the left sidebar, click **+**, select **Drive API** (v3), and click **Add**. Resumable uploads use the Drive API directly.
5. If Apps Script asks for a Google Cloud project/API to be enabled, open the project's linked Cloud project and enable **Google Drive API** under **APIs & Services → Library**. Return to Apps Script when it is enabled.

## 3. Authorize the script

1. In the function selector beside **Run**, choose **`authorizeDrive`** and click **Run**.
2. Choose the intended Google account, review the Google Drive and external-request permissions, and click **Allow**. If Google displays an unverified-app warning for your own script, use **Advanced** and continue to your script project. Follow your Workspace administrator's policy if this is blocked.
3. Confirm the execution completes successfully. This checks Drive access and the Drive API authorization used for large uploads.

## 4. Deploy the Web App

1. In Apps Script, click **Deploy → New deployment**.
2. Click the gear icon next to **Select type**, then choose **Web app**.
3. Set the deployment options exactly as follows:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
4. Click **Deploy** and approve any additional authorization prompt.
5. Copy the **Web app URL**. It should end in **`/exec`**. Use this deployed URL, not the editor URL and not a `/dev` test URL.

> **Access warning:** `Anyone` means the endpoint can be called by anyone who obtains the URL. This app does not include user sign-in or an access code; a caller can list folder names, create folders, and upload allowed file types into the deploying account's Drive. The URL is not a password, and CORS is not access control. Do not use the `Anyone` setting for confidential student records on a publicly accessible page. Where possible, use a school-managed access policy and add proper authentication before handling sensitive records. The deployed script creates files as the owner, but does not automatically grant Drive access to people who open a returned file link.

## 5. Publish the front end on GitHub Pages

The current `index.html` already contains the supplied Apps Script `/exec` URL in the `WEB_APP_URL` constant. It connects automatically on page load; there is no URL field or Connect button. If you create a new Apps Script deployment later, update that constant in `index.html`.

1. Create a GitHub repository and unzip `tarachand-mv-school-document-manager.zip` on your computer.
2. Upload `index.html`, `README.md`, `DEPLOYMENT.md`, and `Code.gs` to the repository. `Code.gs` is the backend source to paste into Apps Script; GitHub Pages does not execute it.
3. In the repository, open **Settings → Pages**. Choose **Deploy from a branch**, select the `main` branch and `/ (root)`, then save.
4. Wait for GitHub Pages to publish and open the site URL it provides. The page automatically checks the `/exec` endpoint and loads the folder tree.

After connecting, use the sidebar to browse/filter folders. Select a folder to view its files, or select **Include nested folders** to browse below it. With no folder selected, enter at least two characters to search all managed folders. Upload photos or PDFs by selecting files or dragging them into the drop zone.

## 6. Update the backend after code changes

Saving edits in the Apps Script editor does not necessarily update an existing versioned deployment. Use **Deploy → Manage deployments**, edit the Web App deployment, select **New version**, and deploy it. Keep the same `/exec` URL if you are editing that deployment.

## Upload limits and troubleshooting

- **Maximum file size:** 100 MiB (104,857,600 bytes), enforced in both `Code.gs` (`MAX_UPLOAD_BYTES`) and `index.html` (`MAX_FILE_BYTES`).
- Files over **10 MiB** are sent as sequential **5 MiB** chunks using a resumable Google Drive upload. Do not send the full large file as one Base64 `uploadFile` request.
- **Large upload fails at session creation:** enable the Drive API for the Apps Script project's Cloud project, run `authorizeDrive` again, and deploy a new version.
- **Health check fails:** verify the copied URL ends in `/exec`, the deployment is active, and its access setting matches your intended use.
- **Drive authorization error:** run `authorizeDrive` again and confirm the deploying account can access the configured master folder.
- **Folder or upload destination is invalid:** refresh the folder list and select a folder shown in the nested tree. Actions are restricted to folders inside the configured location.
- **Browser reports a network/CORS error:** use the deployed `/exec` URL, deploy with the required access setting, and serve the HTML over HTTP or HTTPS rather than opening it as `file://`. The front end sends JSON as `text/plain` and reads the JSON response; do not change the request to `mode: 'no-cors'`.
- **A Drive link does not open for another staff member:** Web App access and Drive file access are separate. The other staff member needs permission to the destination folder/file in Google Drive.
