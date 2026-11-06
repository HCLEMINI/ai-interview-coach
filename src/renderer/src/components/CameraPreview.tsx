// 摄像头预览（无摄像头时显示占位）
import { useEffect, useRef } from 'react'

interface Props {
  stream: MediaStream | null
  className?: string
  mirrored?: boolean
}

export default function CameraPreview({ stream, className = '', mirrored = true }: Props): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  if (!stream) return null
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className={`${className} ${mirrored ? 'scale-x-[-1]' : ''}`}
    />
  )
}
