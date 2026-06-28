import { doSearch } from './searchService.js';

export function searchEndpoint(req, res) {
    const results = doSearch(req.query.q);
    res.json(results);
}
