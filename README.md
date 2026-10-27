# YouTube Clipper

A small local app: paste a YouTube link and save clips or the entire video to **Downloads**. Multiple clips are bundled into one ZIP containing separate MP4s.

## Open

Double-click **Start Clipper.command**. Keep its Terminal window open while using the app. Closing the window stops the server.

Or run:

```sh
cd /Users/gabriel/Desktop/ytclipper
npm start
```

Open **http://127.0.0.1:4317**. No npm packages or API keys are needed.

## Use

1. Paste a link and choose **Load video**.
2. Enter start and end times, such as `1:23` and `1:45`. Seconds (`83`) and hours (`1:02:03`) also work. Drag the timeline handles if you prefer.
3. Choose **Export clip to Downloads** to save a single MP4.

For multiple clips from the same video, enter a range and choose **Add to batch**, then repeat for each range. Choose **Export N clips as ZIP** to save one ZIP to `~/Downloads`. Inside are numbered MP4 files, one per range. Loose batch MP4s are kept in a temporary folder and removed after packaging. Remove a range with ×, or use **Clear** to return to a single clip. You can queue up to 50 clips; the batch list survives a page refresh. Timestamp fields are exported directly only when the batch is empty; otherwise, choose **Add to batch** to include them.

Choose **Download entire video** to save a complete MP4, independently of the timestamp fields or batch list. Whole videos use `[full video]` in the filename. A batch with only one clip also saves as MP4.

Use **Show ZIP in Finder** or **Show in Finder** to locate the saved export. Repeated exports get a number instead of overwriting an existing file.

Batch clips are processed one at a time. A failed clip does not stop the remaining clips. If a batch is cancelled or partly fails, any completed clips are bundled into a partial ZIP, and the app reports which clips were included. The final ZIP creation and file copy finish before cancellation is available again. Temporary files are removed after completion or cancellation. Refreshing the page resumes an in-progress export. Stop the server with Ctrl+C.

## Video quality

The app selects the best source up to 1920 × 1080, preserves aspect ratio and frame rate, and encodes H.264 video with AAC audio into an MP4. ZIP packaging preserves these MP4s without another encode. Lower-resolution videos keep their source resolution and are labeled in the app. Seeking is accurate to source frames. YouTube's embedded preview rounds to whole seconds and depends on the uploader allowing embedded playback; it does not affect exports.

## Tools

Requires Node.js 22+, yt-dlp, FFmpeg, ffprobe, and zip. macOS includes zip, and this Mac already has the other tools installed. On another Mac with Homebrew:

```sh
brew install node yt-dlp ffmpeg
```

If YouTube downloads stop working, update the downloader, then restart the app:

```sh
brew upgrade yt-dlp
```

The app also supports a local executable at `.tools/yt-dlp` or a `YTDLP_PATH` environment variable. `PORT` changes the default port of 4317. `YTCLIPPER_DOWNLOADS` overrides the export directory for testing.

This app runs on the loopback interface on your computer. It contacts YouTube to read and download videos; it does not send clips to an app server. Private videos, age-restricted videos, active live streams, and videos that require sign-in are not supported.

## Checks

```sh
npm test
```

The 11 tests cover timestamp/URL validation, batch sequencing, partial failure, cancellation, packaging errors, API access checks, and real FFmpeg exports. The HTTP integration test creates a batch ZIP, extracts it, verifies both MP4s, checks single/full-video destinations, and confirms that a repeated ZIP never overwrites an earlier one. Tests use local fixtures and temporary folders, clean up after themselves, and do not download samples into your real Downloads or Desktop folders.
