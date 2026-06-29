package ares

// SubjectResponse is the top-level ARES REST API response for a single economic subject.
// Endpoint: GET /ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}
type SubjectResponse struct {
	ICO              string            `json:"ico"`
	ObchodniJmeno    string            `json:"obchodniJmeno"`
	PravniForma      string            `json:"pravniForma"`
	DatumVzniku      string            `json:"datumVzniku"` // "2003-08-26" or empty
	DatumAktualizace string            `json:"datumAktualizace"`
	CzNace           []string          `json:"czNace"`
	Registrace       map[string]string `json:"seznamRegistraci"`
}

// SubjectData holds the parsed ARES data ready for DB update.
type SubjectData struct {
	ICO           string
	ObchodniJmeno string // oficiální obchodní jméno (added KT-A9 for multi-source merge)
	NACECodes     []string
	NACEPrimary   string
	DatumVzniku   string // ISO date or ""
	PravniForma   string // ARES code e.g. "112" = s.r.o.
}

// ParseSubject extracts usable data from the raw ARES response.
func ParseSubject(resp SubjectResponse) SubjectData {
	data := SubjectData{
		ICO:           resp.ICO,
		ObchodniJmeno: resp.ObchodniJmeno,
		NACECodes:     resp.CzNace,
		DatumVzniku:   resp.DatumVzniku,
		PravniForma:   resp.PravniForma,
	}
	if len(resp.CzNace) > 0 {
		data.NACEPrimary = resp.CzNace[0]
	}
	return data
}
