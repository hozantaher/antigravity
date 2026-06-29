import type BaseValidator from '~/models/BaseValidator'

const emailRegexp =
  /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/g
const phoneRegexp = /^[+()\-\s0-9]{6,}$/gm

export default function useValidators() {
  const { t } = useI18n()

  const minValidator = (min: number): BaseValidator =>
    ({
      validator: (val: any): boolean => val && val >= min,
      message: t('form.validator.min', { min }),
    }) as BaseValidator
  const minLengthValidator = (min: number): BaseValidator =>
    ({
      validator: (val: any): boolean => val && val.length >= min,
      message: t('form.validator.minlength', { min }),
    }) as BaseValidator
  const maxValidator = (max: number): BaseValidator =>
    ({
      validator: (val: any): boolean => val && val <= max,
      message: t('form.validator.max', { max }),
    }) as BaseValidator
  const maxLengthValidator = (max: number): BaseValidator =>
    ({
      validator: (val: any): boolean => val && val.length <= max,
      message: t('form.validator.maxlength', { max }),
    }) as BaseValidator
  const emailValidator = (): BaseValidator =>
    ({
      validator: (val: any): boolean => val && val.match(emailRegexp),
      message: t('form.validator.email'),
    }) as BaseValidator
  const phoneValidator = (): BaseValidator =>
    ({
      validator: (val: any): boolean => val && val.match(phoneRegexp),
      message: t('form.validator.phone'),
    }) as BaseValidator

  return { minValidator, maxValidator, emailValidator, phoneValidator, minLengthValidator, maxLengthValidator }
}
