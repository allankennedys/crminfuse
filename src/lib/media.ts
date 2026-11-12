import type { MediaType } from '@/types'

export const MEDIA_LABEL: Record<MediaType, string> = {
  text: 'Texto',
  image: 'Imagem',
  audio: 'Áudio',
  video: 'Vídeo',
  document: 'Documento',
}

export const MEDIA_ACCEPT: Record<MediaType, string> = {
  text: '',
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
  document: '*/*',
}

export const MAX_FILE_SIZE_MB = 100
export const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
