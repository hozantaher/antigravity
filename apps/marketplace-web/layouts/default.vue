<template>
  <main class="page-root">
    <Header />
    <div class="main-content">
      <slot />
    </div>
    <Footer />
    <CookiesBar />
    <ClientOnly>
      <CompareDock />
    </ClientOnly>
  </main>
</template>

<style scoped>
.page-root {
  @apply text-app-text!;
}
</style>
