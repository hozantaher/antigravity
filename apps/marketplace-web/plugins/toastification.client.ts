import Toast, { TYPE } from 'vue-toastification'
import 'vue-toastification/dist/index.css'

export default defineNuxtPlugin(nuxtApp => {
  nuxtApp.vueApp.use(Toast, {
    newestOnTop: false,
    toastDefaults: {
      [TYPE.ERROR]: { timeout: 10000 },
    },
  })
})
