export default function useAdminSearch() {
  const search = useState<string>('admin:search', () => '')
  return { search }
}
