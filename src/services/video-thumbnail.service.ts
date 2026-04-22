import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import ffmpegPath from 'ffmpeg-static'
import { AppError } from '../middlewares/errorHandler'

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new AppError(500, 'FFmpeg binary not available', 'THUMBNAIL_GENERATION_FAILED'))
      return
    }

    const child = spawn(
      ffmpegPath,
      [
        '-y',
        '-i',
        inputPath,
        '-ss',
        '00:00:01',
        '-vframes',
        '1',
        '-q:v',
        '2',
        outputPath,
      ],
      { windowsHide: true },
    )

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (err) => {
      reject(new AppError(500, `FFmpeg spawn failed: ${err.message}`, 'THUMBNAIL_GENERATION_FAILED'))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new AppError(
          500,
          `Failed to generate thumbnail from video${stderr ? `: ${stderr}` : ''}`,
          'THUMBNAIL_GENERATION_FAILED',
        ),
      )
    })
  })
}

export const videoThumbnailService = {
  async createJpegThumbnail(videoBuffer: Buffer): Promise<Buffer> {
    const id = randomUUID()
    const inputPath = path.join(os.tmpdir(), `post-video-${id}.mp4`)
    const outputPath = path.join(os.tmpdir(), `post-video-thumb-${id}.jpg`)

    await fs.writeFile(inputPath, videoBuffer)
    try {
      await runFfmpeg(inputPath, outputPath)
      return await fs.readFile(outputPath)
    } finally {
      await Promise.allSettled([
        fs.unlink(inputPath),
        fs.unlink(outputPath),
      ])
    }
  },
}
