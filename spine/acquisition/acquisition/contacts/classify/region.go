package classify

import "strings"

// NormalizeRegion maps a postal code and/or locality to a Czech kraj.
func NormalizeRegion(postalCode, locality string) string {
	psc := strings.TrimSpace(strings.ReplaceAll(postalCode, " ", ""))

	if len(psc) >= 3 {
		prefix := psc[:3]
		if kraj, ok := pscPrefixToKraj[prefix]; ok {
			return kraj
		}
	}

	// Fallback: first digit
	if len(psc) >= 1 {
		switch psc[0] {
		case '1':
			return "Hlavní město Praha"
		case '2':
			return "Středočeský kraj"
		case '4':
			return "Ústecký kraj"
		case '6':
			return "Jihomoravský kraj"
		}
	}

	return localityToKraj(locality)
}

var pscPrefixToKraj map[string]string

func init() {
	pscPrefixToKraj = make(map[string]string, 400)

	// Praha 100-199
	for i := 100; i <= 199; i++ {
		pscPrefixToKraj[itoa3(i)] = "Hlavní město Praha"
	}
	// Středočeský 250-294
	for i := 250; i <= 294; i++ {
		pscPrefixToKraj[itoa3(i)] = "Středočeský kraj"
	}
	// Plzeňský 300-340
	for i := 300; i <= 340; i++ {
		pscPrefixToKraj[itoa3(i)] = "Plzeňský kraj"
	}
	// Karlovarský 350-365
	for i := 350; i <= 365; i++ {
		pscPrefixToKraj[itoa3(i)] = "Karlovarský kraj"
	}
	// Jihočeský 370-399
	for i := 370; i <= 399; i++ {
		pscPrefixToKraj[itoa3(i)] = "Jihočeský kraj"
	}
	// Ústecký 400-440
	for i := 400; i <= 440; i++ {
		pscPrefixToKraj[itoa3(i)] = "Ústecký kraj"
	}
	// Liberecký 460-475
	for i := 460; i <= 475; i++ {
		pscPrefixToKraj[itoa3(i)] = "Liberecký kraj"
	}
	// Královéhradecký 500-552
	for i := 500; i <= 552; i++ {
		pscPrefixToKraj[itoa3(i)] = "Královéhradecký kraj"
	}
	// Pardubický 530-572 (overlaps with KHK — Pardubice wins for 530-539, 560-572)
	for i := 530; i <= 539; i++ {
		pscPrefixToKraj[itoa3(i)] = "Pardubický kraj"
	}
	for i := 560; i <= 572; i++ {
		pscPrefixToKraj[itoa3(i)] = "Pardubický kraj"
	}
	// Vysočina 580-595
	for i := 580; i <= 595; i++ {
		pscPrefixToKraj[itoa3(i)] = "Kraj Vysočina"
	}
	// Jihomoravský 600-698
	for i := 600; i <= 698; i++ {
		pscPrefixToKraj[itoa3(i)] = "Jihomoravský kraj"
	}
	// Moravskoslezský 700-749
	for i := 700; i <= 749; i++ {
		pscPrefixToKraj[itoa3(i)] = "Moravskoslezský kraj"
	}
	// Olomoucký 750-790
	for i := 750; i <= 790; i++ {
		pscPrefixToKraj[itoa3(i)] = "Olomoucký kraj"
	}
	// Zlínský 760-769 (override Olomoucký for this range)
	for i := 760; i <= 769; i++ {
		pscPrefixToKraj[itoa3(i)] = "Zlínský kraj"
	}
}

func itoa3(n int) string {
	s := [3]byte{byte('0' + n/100), byte('0' + (n/10)%10), byte('0' + n%10)}
	return string(s[:])
}

func localityToKraj(locality string) string {
	l := strings.ToLower(locality)
	switch {
	case strings.Contains(l, "praha"):
		return "Hlavní město Praha"
	case strings.Contains(l, "brno"):
		return "Jihomoravský kraj"
	case strings.Contains(l, "ostrava"):
		return "Moravskoslezský kraj"
	case strings.Contains(l, "plzeň") || strings.Contains(l, "plzen"):
		return "Plzeňský kraj"
	case strings.Contains(l, "liberec"):
		return "Liberecký kraj"
	case strings.Contains(l, "olomouc"):
		return "Olomoucký kraj"
	case strings.Contains(l, "hradec králové") || strings.Contains(l, "hradec kralove"):
		return "Královéhradecký kraj"
	case strings.Contains(l, "pardubic"):
		return "Pardubický kraj"
	case strings.Contains(l, "zlín") || strings.Contains(l, "zlin"):
		return "Zlínský kraj"
	case strings.Contains(l, "jihlav"):
		return "Kraj Vysočina"
	case strings.Contains(l, "české budějovice") || strings.Contains(l, "ceske budejovice"):
		return "Jihočeský kraj"
	case strings.Contains(l, "karlovy vary"):
		return "Karlovarský kraj"
	case strings.Contains(l, "ústí") || strings.Contains(l, "usti"):
		return "Ústecký kraj"
	default:
		return ""
	}
}
