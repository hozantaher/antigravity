<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import type { Item } from '~/models'

const props = defineProps<{
  item: Item
}>()

const emit = defineEmits<{ submitted: [] }>()

const router = useRouter()
const toast = useToast()
const { isLogged, backlink } = useUser()
const { askQuestion } = useItemDetail()
const { t } = useI18n()
const localePath = useLocalePath()

// SSR is anonymous; the logged-in affordance only resolves client-side, so gate on mounted to
// avoid a hydration mismatch (same reasoning as the admin edit link in [itemId].vue).
const mounted = useMounted()

const body = ref('')
const sending = ref(false)

const submit = async () => {
  if (!isLogged.value) {
    backlink.value = localePath(`/item/${props.item.id}`)
    router.push(localePath('/sign'))
    toast.warning(t('messaging.signInFirst'))
    return
  }

  const trimmed = body.value.trim()
  if (!trimmed || sending.value) return

  sending.value = true
  try {
    await askQuestion(trimmed)
    body.value = ''
    // The question is pending (won't appear yet), but refresh keeps the thread current.
    emit('submitted')
    toast.success(t('messaging.submitted'))
  } catch {
    toast.error(t('messaging.error'))
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <form class="question-form" @submit.prevent="submit">
    <textarea
      v-model="body"
      class="question-input"
      rows="3"
      :placeholder="t('messaging.placeholder')"
      :aria-label="t('messaging.ask')"
    />
    <button v-if="mounted" type="submit" class="app-btn-auction submit-btn" :disabled="sending">
      {{ t('messaging.submit') }}
    </button>
  </form>
</template>

<style scoped>
.question-form {
  @apply flex flex-col gap-3;
}

.question-input {
  @apply w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text;

  &:focus {
    @apply border-app-border-strong outline-none;
  }
}

.submit-btn {
  @apply w-auto items-center self-start whitespace-nowrap uppercase;

  &:disabled {
    @apply cursor-not-allowed opacity-50;
  }
}
</style>
