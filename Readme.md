# FuckingFast Direct Link Extractor

A simple browser script that converts **FuckingFast** share links into their final direct download URLs.

The script sends the required POST request for each shared file, extracts the `hx-redirect` response header, and saves all direct links into a text file.

## Features

* Extracts direct download URLs automatically
* Processes multiple links sequentially
* 1-second delay between requests
* Progress logging in the browser console
* Automatically downloads the results as `Out_Direct_Links.txt`
* No external dependencies

## Requirements

This repository contains two scripts:

* **fitgirl-extract.js** - Extracts all FuckingFast links from a FitGirl repack page.
* **extract-direct.js** - Converts those links into direct download URLs.

## Usage

### Step 1 - Extract the FuckingFast Links

1. Open the desired **FitGirl** game page.
2. Open **Developer Tools** (`F12`).
3. Go to the **Console** tab.
4. Paste and run **`fitgirl-extract.js`**.
5. Copy the generated `links` array.

### Step 2 - Extract Direct Download Links

1. Open **the first FuckingFast URL** from the extracted array.
2. Open **Developer Tools** (`F12`) and switch to the **Console**.
3. Open **`extract-direct.js`**.
4. Replace the `links` array with the one copied from the previous step.
5. Paste the entire script into the console and press **Enter**.

The script will:

* Process every link
* Print progress in the console
* Extract the direct download URL from each page
* Automatically download the results as:

```text
Out_Direct_Links.txt
```

## How It Works

For every link, the script:

1. Extracts the file ID.
2. Sends a POST request to:

```text
/f/{id}/go
```

3. Reads the `hx-redirect` response header.
4. Stores the direct download URL.
5. Repeats until every link has been processed.

## Example Output

```text
https://cdn1.example.com/file1.rar
https://cdn2.example.com/file2.rar
https://cdn3.example.com/file3.rar
```

## Related Projects

### [FFBypasser Userscript](https://github.com/cdxud/FFBypasser/blob/main/FFBypasser.user.js)

For users who prefer a browser userscript, you can also use **FFBypasser**, the userscript version of this project.

### [FFBypasser GUI BY INMENR](https://github.com/INMENR/FFBypasser-GUI)

A community-created GUI implementation is also available as a separate fork.

## Support

If you find this project useful and want to support its development:

[Support me on Ko-fi](https://ko-fi.com/s_x7ui)


## Notes

* Run **`fitgirl-extract.js`** only on a FitGirl game page.
* Run **`extract-direct.js`** only after opening the **first FuckingFast link** in your browser.
* The script uses relative requests, so it must be executed from a FuckingFast page.
* A 1-second delay is included between requests to avoid sending them too quickly.
* Failed requests are reported in the browser console without stopping the extraction.
