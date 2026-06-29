// Posts a single image to the admin upload endpoint, which stores it in Firebase Storage
// (public/ads/{itemId}/) and returns a tokened download URL. Bearer auth is added by
// plugins/api.client.ts; ofetch sets the multipart boundary from the FormData body.

// iPhone/iPad photos are HEIC (HEVC), which the server pipeline (sharp) and the image-processing
// extension can't decode and most browsers can't display. Convert to JPEG in the browser before
// upload so the server only ever stores web-safe formats. Match by MIME type OR extension — uploads
// from Files/desktop/Android often arrive with an empty or generic content-type.
const HEIC_EXT = /\.(heic|heif)$/i

const isHeic = (file: File): boolean => {
  const type = file.type.toLowerCase()
  return type === 'image/heic' || type === 'image/heif' || HEIC_EXT.test(file.name)
}

const canvasToJpeg = (canvas: HTMLCanvasElement, name: string): Promise<File> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      blob =>
        blob ? resolve(new File([blob], name, { type: 'image/jpeg' })) : reject(new Error('canvas encode failed')),
      'image/jpeg',
      0.9,
    ),
  )

// Native decode: Safari (and any engine that renders HEIC) decodes via <img> for free — it's the OS
// codec, so it handles the HDR/10-bit iPhone files that WASM libheif builds can reject. Throws in
// Chrome/Firefox (can't load HEIC into an <img>), so the caller falls through to the WASM path.
const decodeNative = (file: File, name: string): Promise<File> => {
  const url = URL.createObjectURL(file)
  return new Promise<File>((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => reject(new Error('native decode timed out')), 20_000)
    img.onerror = () => {
      clearTimeout(timer)
      reject(new Error('native decode unsupported'))
    }
    img.onload = () => {
      clearTimeout(timer)
      if (!img.naturalWidth) return reject(new Error('native decode empty'))
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d')!.drawImage(img, 0, 0)
      resolve(canvasToJpeg(canvas, name))
    }
    img.src = url
  }).finally(() => URL.revokeObjectURL(url))
}

// WASM fallback: current libheif (1.19, carries the iOS-18 HEIC parsing fixes) via libheif-js.
// Dynamic-imported so its ~2MB bundle stays out of the initial admin chunk and off the server,
// loading only when a non-Safari browser actually needs to decode a HEIC.
const decodeWasm = async (file: File, name: string): Promise<File> => {
  const { default: libheif } = await import('libheif-js/wasm-bundle')
  const images = new libheif.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()))
  const image = images[0]
  if (!image) throw new Error('libheif: no image decoded')
  const width = image.get_width()
  const height = image.get_height()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  await new Promise<void>((resolve, reject) =>
    image.display(imageData, result => (result ? resolve() : reject(new Error('libheif: display failed')))),
  )
  ctx.putImageData(imageData, 0, 0)
  return canvasToJpeg(canvas, name)
}

// Native first (covers Safari/Apple incl. HDR), WASM fallback for everything else.
const convertHeicToJpeg = async (file: File): Promise<File> => {
  const name = `${file.name.replace(HEIC_EXT, '') || 'image'}.jpg`
  try {
    return await decodeNative(file, name)
  } catch {
    return await decodeWasm(file, name)
  }
}

export const useImageUpload = () => {
  const pending = ref(false)
  const error = ref<string | null>(null)

  const execute = async (file: File, itemId: string): Promise<string | null> => {
    pending.value = true
    error.value = null
    try {
      const prepared = isHeic(file) ? await convertHeicToJpeg(file).catch(() => null) : file
      if (!prepared) {
        error.value = 'HEIC conversion failed — please export the photo as JPEG'
        return null
      }
      const form = new FormData()
      form.append('itemId', itemId)
      form.append('file', prepared)
      const res = await $fetch<{ url: string }>('/api/admin/uploads', { method: 'POST', body: form })
      return res.url
    } catch (e) {
      error.value = apiErrorMessage(e, 'Upload failed')
      return null
    } finally {
      pending.value = false
    }
  }

  return { execute, pending, error }
}
