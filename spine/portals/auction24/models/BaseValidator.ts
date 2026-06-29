export default interface BaseValidator {
  validator: (value: any) => unknown
  message: string
}
