import { execSync, spawnSync } from "child_process";
import fs from "fs";
import inquirer from "inquirer";
import path from "path";
import { finished } from "stream/promises";
import { fileURLToPath } from "url";

// Get the directory name based on the current file path.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Gets the duration of a given file in seconds.
 * @param {string} filePath - The path to the file to get the duration from.
 * @returns {Promise<number>} - The duration of the file in seconds.
 */
async function getDuration(filePath) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf-8" }
  );

  return parseFloat(result.stdout.trim());
}

async function main() {
  // Set paths for audio input folder and output folder.
  const audioRoot = path.join(__dirname, "audio");
  const outputRoot = path.join(__dirname, "output");

  // Create the output folder if it doesn't exist.
  if (!fs.existsSync(outputRoot)) {
    fs.mkdirSync(outputRoot);
  }

  // Scan subfolders within the audio folder.
  const folders = fs.readdirSync(audioRoot).filter((file) => {
    const fullPath = path.join(audioRoot, file);
    return fs.statSync(fullPath).isDirectory();
  });

  // Exit if no subfolders are found.
  if (folders.length === 0) {
    console.error("❌ audio 폴더 안에 하위 폴더가 없습니다.");
    process.exit(1);
  }

  // Prompt user to select a folder.
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "selectedFolder",
      message: "어떤 폴더를 사용할까요?",
      choices: folders,
    },
  ]);

  // Prompt user to select an encoding preset.
  const presetAnswer = await inquirer.prompt([
    {
      type: "list",
      name: "preset",
      message: "인코딩 속도를 선택하세요 (품질과 속도 트레이드오프)",
      choices: ["veryslow", "slow", "medium", "fast"],
      default: "medium",
    },
  ]);

  const selectedPreset = presetAnswer.preset;

  const folderName = answers.selectedFolder;
  const audioDir = path.join(audioRoot, folderName);
  const outputDir = path.join(outputRoot, folderName); // Final output directory

  // Create the output directory if it doesn't exist.
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Temporary files will now be created within the outputDir
  const tempFile = path.join(outputDir, `temp_full_${folderName}.mp3`); // Merged temporary audio file
  const listFile = path.join(outputDir, `filelist_${folderName}.txt`); // File list for FFmpeg concat

  const outputMp4 = path.join(outputDir, `output_${folderName}.mp4`); // Final MP4 output file
  const outputMp3 = path.join(outputDir, `output_${folderName}.mp3`); // Merged MP3 backup file

  // Filter and sort mp3 files within the selected folder.
  let files = fs
    .readdirSync(audioDir)
    .filter((file) => file.toLowerCase().endsWith(".mp3"));
  files.sort();

  // Exit if no mp3 files are found.
  if (files.length === 0) {
    console.error(`❌ ${folderName} 폴더 안에 mp3 파일이 없습니다.`);
    process.exit(1);
  }

  console.log(`🎵 사용할 파일: ${files.join(", ")}`);

  // Create filelist.txt for FFmpeg concat.
  const writeStream = fs.createWriteStream(listFile);
  for (let file of files) {
    const filePath = path.resolve(audioDir, file);
    writeStream.write(`file '${filePath}'\n`);
  }
  writeStream.end();
  await finished(writeStream); // Wait until file writing is complete.

  console.log("🔁 오디오 병합 시작...");
  // Use FFmpeg to merge mp3 files into a single temporary file.
  // -y: overwrite existing file, -f concat: use concat demuxer, -safe 0: allow unsafe paths (if needed), -i: input file
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${tempFile}"`,
    { stdio: "inherit" } // Display FFmpeg output in console.
  );
  console.log("✅ 오디오 병합 완료");

  // Backup the merged MP3 file.
  fs.copyFileSync(tempFile, outputMp3);
  console.log("✅ 병합 mp3 백업 완료:", outputMp3);

  // Determine the background media to use.
  let selectedBackgroundMedia;
  const bgVideo = path.join(audioDir, "bg.mp4"); // Background video file
  const thumbnail = path.join(audioDir, "thumbnail.jpg"); // Thumbnail image file

  const hasBgVideo = fs.existsSync(bgVideo);
  const hasThumbnail = fs.existsSync(thumbnail);

  if (hasBgVideo && hasThumbnail) {
    // If both exist, prompt user to choose.
    const mediaAnswer = await inquirer.prompt([
      {
        type: "list",
        name: "backgroundMedia",
        message: "배경으로 사용할 미디어를 선택하세요:",
        choices: [
          { name: "bg.mp4 (비디오)", value: "video" },
          { name: "thumbnail.jpg (이미지)", value: "image" },
        ],
      },
    ]);
    selectedBackgroundMedia = mediaAnswer.backgroundMedia;
  } else if (hasBgVideo) {
    // If only bg.mp4 exists.
    console.log("ℹ️ bg.mp4만 존재하여 자동으로 선택되었습니다.");
    selectedBackgroundMedia = "video";
  } else if (hasThumbnail) {
    // If only thumbnail.jpg exists.
    console.log("ℹ️ thumbnail.jpg만 존재하여 자동으로 선택되었습니다.");
    selectedBackgroundMedia = "image";
  } else {
    // If neither exist, display error and exit.
    console.error(
      "❌ bg.mp4와 thumbnail.jpg 둘 다 없습니다. 최소 한 개 필요합니다."
    );
    process.exit(1);
  }

  // Generate video based on selected background media.
  if (selectedBackgroundMedia === "video") {
    console.log("🎞️ bg.mp4 기반으로 영상 생성 시작 (개선된 오디오 처리)");

    // Get the duration of the merged audio file.
    const audioDuration = await getDuration(tempFile);
    console.log(`🎧 오디오 길이: ${audioDuration.toFixed(2)}초`);

    // FFmpeg command: loop bg.mp4, overlay merged audio, adjust video length to audio length.
    // -stream_loop -1: infinite loop for the first input (bgVideo)
    // -i "${bgVideo}": first input is the background video
    // -i "${tempFile}": second input is the merged audio
    // -map 0:v: map only the video stream from the first input (bgVideo)
    // -map 1:a: map only the audio stream from the second input (tempFile) (prevents audio duplication)
    // -t ${audioDuration}: set output video duration to match audio duration
    // -c:v libx264: video codec
    // -crf 18: video quality (lower is higher quality)
    // -preset ${selectedPreset}: encoding speed/quality preset
    // -pix_fmt yuv420p: pixel format (compatibility)
    // -c:a aac: audio codec
    // -b:a 320k: set audio bitrate to 320kbps (improves sound quality)
    execSync(
      `ffmpeg -y -stream_loop -1 -i "${bgVideo}" -i "${tempFile}" -map 0:v -map 1:a -t ${audioDuration} -c:v libx264 -crf 18 -preset ${selectedPreset} -pix_fmt yuv420p -c:a aac -b:a 320k "${outputMp4}"`,
      { stdio: "inherit" }
    );
  } else if (selectedBackgroundMedia === "image") {
    console.log(
      "🖼️ thumbnail.jpg 기반으로 영상 생성 시작 (개선된 오디오 처리)"
    );

    // FFmpeg command: loop thumbnail, overlay audio.
    // -loop 1: loop the first input (thumbnail)
    // -i "${thumbnail}": first input is the thumbnail image
    // -i "${tempFile}": second input is the merged audio
    // -vf "scale=iw:ih,pad=ceil(iw/2)*2:ceil(ih/2)*2": video filter (pads to even resolution for compatibility)
    // -c:v libx264 -tune stillimage: video encoding optimized for still images
    // -crf 18: video quality
    // -preset ${selectedPreset}: encoding speed/quality preset
    // -c:a aac: audio codec
    // -b:a 320k: set audio bitrate to 320kbps (improves sound quality)
    // -shortest: adjust output video length to the shortest input stream (here, audio)
    // -pix_fmt yuv420p: pixel format
    execSync(
      `ffmpeg -y -loop 1 -i "${thumbnail}" -i "${tempFile}" -vf "scale=iw:ih,pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -tune stillimage -crf 18 -preset ${selectedPreset} -c:a aac -b:a 320k -shortest -pix_fmt yuv420p "${outputMp4}"`,
      { stdio: "inherit" }
    );
  }

  console.log("✅ 영상 생성 완료:", outputMp4);

  // Delete temporary files.
  fs.unlinkSync(tempFile);
  fs.unlinkSync(listFile);
  console.log("🧹 임시 파일 삭제 완료.");
}

main();
