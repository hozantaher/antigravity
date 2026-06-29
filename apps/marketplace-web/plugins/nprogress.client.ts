import NProgress from 'nprogress'

export default defineNuxtPlugin(() => {
  const router = useRouter()
  router.beforeEach((to, from) => {
    if (to.path !== from.path) NProgress.start()
  })
  router.afterEach(() => NProgress.done())
})
