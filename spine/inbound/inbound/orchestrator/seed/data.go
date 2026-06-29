package seed

// testCompany holds all fields needed to seed both Schema A (contacts)
// and Schema B (outreach_contacts + outreach_domains).
type testCompany struct {
	domain      string
	firstName   string
	lastName    string
	email       string
	companyName string
	ico         string
	region      string
	industry    string
	companySize string
}

// testData returns 60 realistic Czech machinery/industrial contacts across 20 domains.
// All domains use the .test TLD (RFC 6761) to prevent accidental real sends.
func testData() []testCompany {
	return []testCompany{
		// Domain: stroje-novak.test (Praha, machinery)
		{domain: "stroje-novak.test", firstName: "Jan", lastName: "Novak", email: "jan.novak@stroje-novak.test", companyName: "Strojirna Novak s.r.o.", ico: "12345601", region: "Praha", industry: "machinery", companySize: "10-49"},
		{domain: "stroje-novak.test", firstName: "Eva", lastName: "Novakova", email: "eva.novakova@stroje-novak.test", companyName: "Strojirna Novak s.r.o.", ico: "12345601", region: "Praha", industry: "machinery", companySize: "10-49"},
		{domain: "stroje-novak.test", firstName: "Karel", lastName: "Prochazka", email: "karel.prochazka@stroje-novak.test", companyName: "Strojirna Novak s.r.o.", ico: "12345601", region: "Praha", industry: "machinery", companySize: "10-49"},

		// Domain: kovarna-kral.test (Brno, metalwork)
		{domain: "kovarna-kral.test", firstName: "Petra", lastName: "Kralova", email: "petra.kralova@kovarna-kral.test", companyName: "Kovarna Kral a.s.", ico: "12345602", region: "Brno", industry: "metalwork", companySize: "50-99"},
		{domain: "kovarna-kral.test", firstName: "Martin", lastName: "Kral", email: "martin.kral@kovarna-kral.test", companyName: "Kovarna Kral a.s.", ico: "12345602", region: "Brno", industry: "metalwork", companySize: "50-99"},
		{domain: "kovarna-kral.test", firstName: "Lukas", lastName: "Dvorak", email: "lukas.dvorak@kovarna-kral.test", companyName: "Kovarna Kral a.s.", ico: "12345602", region: "Brno", industry: "metalwork", companySize: "50-99"},

		// Domain: stavby-ostrava.test (Ostrava, construction)
		{domain: "stavby-ostrava.test", firstName: "Tomas", lastName: "Horak", email: "tomas.horak@stavby-ostrava.test", companyName: "Stavby Ostrava s.r.o.", ico: "12345603", region: "Ostrava", industry: "construction", companySize: "10-49"},
		{domain: "stavby-ostrava.test", firstName: "Alena", lastName: "Horakova", email: "alena.horakova@stavby-ostrava.test", companyName: "Stavby Ostrava s.r.o.", ico: "12345603", region: "Ostrava", industry: "construction", companySize: "10-49"},
		{domain: "stavby-ostrava.test", firstName: "David", lastName: "Cerny", email: "david.cerny@stavby-ostrava.test", companyName: "Stavby Ostrava s.r.o.", ico: "12345603", region: "Ostrava", industry: "construction", companySize: "10-49"},

		// Domain: plasty-plzen.test (Plzen, plastics)
		{domain: "plasty-plzen.test", firstName: "Jakub", lastName: "Vesely", email: "jakub.vesely@plasty-plzen.test", companyName: "Plasty Plzen s.r.o.", ico: "12345604", region: "Plzen", industry: "plastics", companySize: "5-9"},
		{domain: "plasty-plzen.test", firstName: "Monika", lastName: "Vesela", email: "monika.vesela@plasty-plzen.test", companyName: "Plasty Plzen s.r.o.", ico: "12345604", region: "Plzen", industry: "plastics", companySize: "5-9"},
		{domain: "plasty-plzen.test", firstName: "Ondrej", lastName: "Marek", email: "ondrej.marek@plasty-plzen.test", companyName: "Plasty Plzen s.r.o.", ico: "12345604", region: "Plzen", industry: "plastics", companySize: "5-9"},

		// Domain: cnc-liberec.test (Liberec, machinery)
		{domain: "cnc-liberec.test", firstName: "Filip", lastName: "Pospisil", email: "filip.pospisil@cnc-liberec.test", companyName: "CNC Liberec s.r.o.", ico: "12345605", region: "Liberec", industry: "machinery", companySize: "10-49"},
		{domain: "cnc-liberec.test", firstName: "Vojtech", lastName: "Fiala", email: "vojtech.fiala@cnc-liberec.test", companyName: "CNC Liberec s.r.o.", ico: "12345605", region: "Liberec", industry: "machinery", companySize: "10-49"},
		{domain: "cnc-liberec.test", firstName: "Zuzana", lastName: "Fialova", email: "zuzana.fialova@cnc-liberec.test", companyName: "CNC Liberec s.r.o.", ico: "12345605", region: "Liberec", industry: "machinery", companySize: "10-49"},

		// Domain: agro-vysocina.test (Jihlava, agriculture)
		{domain: "agro-vysocina.test", firstName: "Radek", lastName: "Blaha", email: "radek.blaha@agro-vysocina.test", companyName: "Agro Vysocina s.r.o.", ico: "12345606", region: "Jihlava", industry: "agriculture", companySize: "10-49"},
		{domain: "agro-vysocina.test", firstName: "Lenka", lastName: "Blahova", email: "lenka.blahova@agro-vysocina.test", companyName: "Agro Vysocina s.r.o.", ico: "12345606", region: "Jihlava", industry: "agriculture", companySize: "10-49"},
		{domain: "agro-vysocina.test", firstName: "Miroslav", lastName: "Ruzicka", email: "miroslav.ruzicka@agro-vysocina.test", companyName: "Agro Vysocina s.r.o.", ico: "12345606", region: "Jihlava", industry: "agriculture", companySize: "10-49"},

		// Domain: svar-chomutov.test (Usti nad Labem, metalwork)
		{domain: "svar-chomutov.test", firstName: "Stanislav", lastName: "Kovar", email: "stanislav.kovar@svar-chomutov.test", companyName: "Svarna Chomutov s.r.o.", ico: "12345607", region: "Usti nad Labem", industry: "metalwork", companySize: "5-9"},
		{domain: "svar-chomutov.test", firstName: "Hana", lastName: "Kovarova", email: "hana.kovarova@svar-chomutov.test", companyName: "Svarna Chomutov s.r.o.", ico: "12345607", region: "Usti nad Labem", industry: "metalwork", companySize: "5-9"},
		{domain: "svar-chomutov.test", firstName: "Roman", lastName: "Sedlak", email: "roman.sedlak@svar-chomutov.test", companyName: "Svarna Chomutov s.r.o.", ico: "12345607", region: "Usti nad Labem", industry: "metalwork", companySize: "5-9"},

		// Domain: transport-hk.test (Hradec Kralove, transport)
		{domain: "transport-hk.test", firstName: "Jiri", lastName: "Blazek", email: "jiri.blazek@transport-hk.test", companyName: "Transport HK a.s.", ico: "12345608", region: "Hradec Kralove", industry: "transport", companySize: "50-99"},
		{domain: "transport-hk.test", firstName: "Marketa", lastName: "Blazkova", email: "marketa.blazkova@transport-hk.test", companyName: "Transport HK a.s.", ico: "12345608", region: "Hradec Kralove", industry: "transport", companySize: "50-99"},
		{domain: "transport-hk.test", firstName: "Tomas", lastName: "Rous", email: "tomas.rous@transport-hk.test", companyName: "Transport HK a.s.", ico: "12345608", region: "Hradec Kralove", industry: "transport", companySize: "50-99"},

		// Domain: kovy-olomouc.test (Olomouc, metalwork)
		{domain: "kovy-olomouc.test", firstName: "Petr", lastName: "Nemec", email: "petr.nemec@kovy-olomouc.test", companyName: "Kovy Olomouc s.r.o.", ico: "12345609", region: "Olomouc", industry: "metalwork", companySize: "10-49"},
		{domain: "kovy-olomouc.test", firstName: "Veronika", lastName: "Nemcova", email: "veronika.nemcova@kovy-olomouc.test", companyName: "Kovy Olomouc s.r.o.", ico: "12345609", region: "Olomouc", industry: "metalwork", companySize: "10-49"},
		{domain: "kovy-olomouc.test", firstName: "Michal", lastName: "Novotny", email: "michal.novotny@kovy-olomouc.test", companyName: "Kovy Olomouc s.r.o.", ico: "12345609", region: "Olomouc", industry: "metalwork", companySize: "10-49"},

		// Domain: drevo-jihlava.test (Jihlava, woodwork)
		{domain: "drevo-jihlava.test", firstName: "Pavel", lastName: "Hajek", email: "pavel.hajek@drevo-jihlava.test", companyName: "Drevovyroba Jihlava s.r.o.", ico: "12345610", region: "Jihlava", industry: "woodwork", companySize: "5-9"},
		{domain: "drevo-jihlava.test", firstName: "Ivana", lastName: "Hajkova", email: "ivana.hajkova@drevo-jihlava.test", companyName: "Drevovyroba Jihlava s.r.o.", ico: "12345610", region: "Jihlava", industry: "woodwork", companySize: "5-9"},
		{domain: "drevo-jihlava.test", firstName: "Zbynek", lastName: "Rihak", email: "zbynek.rihak@drevo-jihlava.test", companyName: "Drevovyroba Jihlava s.r.o.", ico: "12345610", region: "Jihlava", industry: "woodwork", companySize: "5-9"},

		// Domain: stavebni-cb.test (Ceske Budejovice, construction)
		{domain: "stavebni-cb.test", firstName: "Lucie", lastName: "Kratka", email: "lucie.kratka@stavebni-cb.test", companyName: "Stavebni CB s.r.o.", ico: "12345611", region: "Ceske Budejovice", industry: "construction", companySize: "10-49"},
		{domain: "stavebni-cb.test", firstName: "Bohuslav", lastName: "Kratky", email: "bohuslav.kratky@stavebni-cb.test", companyName: "Stavebni CB s.r.o.", ico: "12345611", region: "Ceske Budejovice", industry: "construction", companySize: "10-49"},
		{domain: "stavebni-cb.test", firstName: "Renata", lastName: "Mala", email: "renata.mala@stavebni-cb.test", companyName: "Stavebni CB s.r.o.", ico: "12345611", region: "Ceske Budejovice", industry: "construction", companySize: "10-49"},

		// Domain: tech-kladno.test (Kladno, machinery)
		{domain: "tech-kladno.test", firstName: "Antonin", lastName: "Dolezal", email: "antonin.dolezal@tech-kladno.test", companyName: "Technika Kladno s.r.o.", ico: "12345612", region: "Kladno", industry: "machinery", companySize: "10-49"},
		{domain: "tech-kladno.test", firstName: "Dagmar", lastName: "Dolezalova", email: "dagmar.dolezalova@tech-kladno.test", companyName: "Technika Kladno s.r.o.", ico: "12345612", region: "Kladno", industry: "machinery", companySize: "10-49"},
		{domain: "tech-kladno.test", firstName: "Oldrich", lastName: "Kubes", email: "oldrich.kubes@tech-kladno.test", companyName: "Technika Kladno s.r.o.", ico: "12345612", region: "Kladno", industry: "machinery", companySize: "10-49"},

		// Domain: guma-usti.test (Usti nad Labem, plastics)
		{domain: "guma-usti.test", firstName: "Tereza", lastName: "Pokorny", email: "tereza.pokorny@guma-usti.test", companyName: "Guma Usti s.r.o.", ico: "12345613", region: "Usti nad Labem", industry: "plastics", companySize: "5-9"},
		{domain: "guma-usti.test", firstName: "Vladimir", lastName: "Pokorna", email: "vladimir.pokorna@guma-usti.test", companyName: "Guma Usti s.r.o.", ico: "12345613", region: "Usti nad Labem", industry: "plastics", companySize: "5-9"},
		{domain: "guma-usti.test", firstName: "Simona", lastName: "Riha", email: "simona.riha@guma-usti.test", companyName: "Guma Usti s.r.o.", ico: "12345613", region: "Usti nad Labem", industry: "plastics", companySize: "5-9"},

		// Domain: jerab-mb.test (Mlada Boleslav, machinery)
		{domain: "jerab-mb.test", firstName: "Frantisek", lastName: "Vlcek", email: "frantisek.vlcek@jerab-mb.test", companyName: "Jerabova Technika MB s.r.o.", ico: "12345614", region: "Mlada Boleslav", industry: "machinery", companySize: "10-49"},
		{domain: "jerab-mb.test", firstName: "Gabriela", lastName: "Vlckova", email: "gabriela.vlckova@jerab-mb.test", companyName: "Jerabova Technika MB s.r.o.", ico: "12345614", region: "Mlada Boleslav", industry: "machinery", companySize: "10-49"},
		{domain: "jerab-mb.test", firstName: "Igor", lastName: "Polak", email: "igor.polak@jerab-mb.test", companyName: "Jerabova Technika MB s.r.o.", ico: "12345614", region: "Mlada Boleslav", industry: "machinery", companySize: "10-49"},

		// Domain: pila-trutnov.test (Trutnov, woodwork)
		{domain: "pila-trutnov.test", firstName: "Jaroslav", lastName: "Urban", email: "jaroslav.urban@pila-trutnov.test", companyName: "Pila Trutnov s.r.o.", ico: "12345615", region: "Trutnov", industry: "woodwork", companySize: "5-9"},
		{domain: "pila-trutnov.test", firstName: "Kamila", lastName: "Urbanova", email: "kamila.urbanova@pila-trutnov.test", companyName: "Pila Trutnov s.r.o.", ico: "12345615", region: "Trutnov", industry: "woodwork", companySize: "5-9"},
		{domain: "pila-trutnov.test", firstName: "Libor", lastName: "Zeman", email: "libor.zeman@pila-trutnov.test", companyName: "Pila Trutnov s.r.o.", ico: "12345615", region: "Trutnov", industry: "woodwork", companySize: "5-9"},

		// Domain: agro-zlin.test (Zlin, agriculture)
		{domain: "agro-zlin.test", firstName: "Natalie", lastName: "Stehlik", email: "natalie.stehlik@agro-zlin.test", companyName: "Agro Zlin a.s.", ico: "12345616", region: "Zlin", industry: "agriculture", companySize: "50-99"},
		{domain: "agro-zlin.test", firstName: "Ondrej", lastName: "Stehlík", email: "ondrej.stehlik@agro-zlin.test", companyName: "Agro Zlin a.s.", ico: "12345616", region: "Zlin", industry: "agriculture", companySize: "50-99"},
		{domain: "agro-zlin.test", firstName: "Pavlina", lastName: "Straka", email: "pavlina.straka@agro-zlin.test", companyName: "Agro Zlin a.s.", ico: "12345616", region: "Zlin", industry: "agriculture", companySize: "50-99"},

		// Domain: obrabeni-pardubice.test (Pardubice, machinery)
		{domain: "obrabeni-pardubice.test", firstName: "Radoslav", lastName: "Kolar", email: "radoslav.kolar@obrabeni-pardubice.test", companyName: "Obrabeni Pardubice s.r.o.", ico: "12345617", region: "Pardubice", industry: "machinery", companySize: "10-49"},
		{domain: "obrabeni-pardubice.test", firstName: "Sarka", lastName: "Kolarova", email: "sarka.kolarova@obrabeni-pardubice.test", companyName: "Obrabeni Pardubice s.r.o.", ico: "12345617", region: "Pardubice", industry: "machinery", companySize: "10-49"},
		{domain: "obrabeni-pardubice.test", firstName: "Tomas", lastName: "Pospichal", email: "tomas.pospichal@obrabeni-pardubice.test", companyName: "Obrabeni Pardubice s.r.o.", ico: "12345617", region: "Pardubice", industry: "machinery", companySize: "10-49"},

		// Domain: svary-kv.test (Karlovy Vary, metalwork)
		{domain: "svary-kv.test", firstName: "Uwe", lastName: "Brandt", email: "uwe.brandt@svary-kv.test", companyName: "Svary KV s.r.o.", ico: "12345618", region: "Karlovy Vary", industry: "metalwork", companySize: "5-9"},
		{domain: "svary-kv.test", firstName: "Vanda", lastName: "Brandtova", email: "vanda.brandtova@svary-kv.test", companyName: "Svary KV s.r.o.", ico: "12345618", region: "Karlovy Vary", industry: "metalwork", companySize: "5-9"},
		{domain: "svary-kv.test", firstName: "Ales", lastName: "Mares", email: "ales.mares@svary-kv.test", companyName: "Svary KV s.r.o.", ico: "12345618", region: "Karlovy Vary", industry: "metalwork", companySize: "5-9"},

		// Domain: logistika-brno.test (Brno, transport)
		{domain: "logistika-brno.test", firstName: "Borivoj", lastName: "Krejci", email: "borivoj.krejci@logistika-brno.test", companyName: "Logistika Brno s.r.o.", ico: "12345619", region: "Brno", industry: "transport", companySize: "10-49"},
		{domain: "logistika-brno.test", firstName: "Cveta", lastName: "Krejcova", email: "cveta.krejcova@logistika-brno.test", companyName: "Logistika Brno s.r.o.", ico: "12345619", region: "Brno", industry: "transport", companySize: "10-49"},
		{domain: "logistika-brno.test", firstName: "Daniel", lastName: "Ryba", email: "daniel.ryba@logistika-brno.test", companyName: "Logistika Brno s.r.o.", ico: "12345619", region: "Brno", industry: "transport", companySize: "10-49"},

		// Domain: farma-olomouc.test (Olomouc, agriculture)
		{domain: "farma-olomouc.test", firstName: "Eduard", lastName: "Hajny", email: "eduard.hajny@farma-olomouc.test", companyName: "Farma Olomouc a.s.", ico: "12345620", region: "Olomouc", industry: "agriculture", companySize: "50-99"},
		{domain: "farma-olomouc.test", firstName: "Frantiska", lastName: "Hajna", email: "frantiska.hajna@farma-olomouc.test", companyName: "Farma Olomouc a.s.", ico: "12345620", region: "Olomouc", industry: "agriculture", companySize: "50-99"},
		{domain: "farma-olomouc.test", firstName: "Gregor", lastName: "Mraz", email: "gregor.mraz@farma-olomouc.test", companyName: "Farma Olomouc a.s.", ico: "12345620", region: "Olomouc", industry: "agriculture", companySize: "50-99"},
	}
}

// uniqueDomains extracts distinct domains from test data.
func uniqueDomains() []string {
	seen := map[string]bool{}
	var domains []string
	for _, c := range testData() {
		if !seen[c.domain] {
			seen[c.domain] = true
			domains = append(domains, c.domain)
		}
	}
	return domains
}

// firmyCompanies returns one company per domain for firmy_cz_businesses seeding.
type firmyCompany struct {
	name     string
	email    string
	ico      string
	region   string
	size     string
	category string
}

func firmyCompanies() []firmyCompany {
	return []firmyCompany{
		{name: "Strojirna Novak s.r.o.", email: "info@stroje-novak.test", ico: "12345601", region: "Praha", size: "10-49", category: "Strojirenstvi > Obrabeni kovu"},
		{name: "Kovarna Kral a.s.", email: "info@kovarna-kral.test", ico: "12345602", region: "Brno", size: "50-99", category: "Hutnictvi > Kovarstvi"},
		{name: "Stavby Ostrava s.r.o.", email: "info@stavby-ostrava.test", ico: "12345603", region: "Ostrava", size: "10-49", category: "Stavebnictvi > Pozemni stavby"},
		{name: "Plasty Plzen s.r.o.", email: "info@plasty-plzen.test", ico: "12345604", region: "Plzen", size: "5-9", category: "Plasty > Vstrikovani plastu"},
		{name: "CNC Liberec s.r.o.", email: "info@cnc-liberec.test", ico: "12345605", region: "Liberec", size: "10-49", category: "Strojirenstvi > CNC obrabeni"},
		{name: "Agro Vysocina s.r.o.", email: "info@agro-vysocina.test", ico: "12345606", region: "Jihlava", size: "10-49", category: "Zemedelstvi > Rostlinna vyroba"},
		{name: "Svarna Chomutov s.r.o.", email: "info@svar-chomutov.test", ico: "12345607", region: "Usti nad Labem", size: "5-9", category: "Hutnictvi > Svarovani"},
		{name: "Transport HK a.s.", email: "info@transport-hk.test", ico: "12345608", region: "Hradec Kralove", size: "50-99", category: "Doprava > Nakladni doprava"},
		{name: "Kovy Olomouc s.r.o.", email: "info@kovy-olomouc.test", ico: "12345609", region: "Olomouc", size: "10-49", category: "Hutnictvi > Zpracovani kovu"},
		{name: "Drevovyroba Jihlava s.r.o.", email: "info@drevo-jihlava.test", ico: "12345610", region: "Jihlava", size: "5-9", category: "Drevovyroba > Pila"},
		{name: "Stavebni CB s.r.o.", email: "info@stavebni-cb.test", ico: "12345611", region: "Ceske Budejovice", size: "10-49", category: "Stavebnictvi > Pozemni stavby"},
		{name: "Technika Kladno s.r.o.", email: "info@tech-kladno.test", ico: "12345612", region: "Kladno", size: "10-49", category: "Strojirenstvi > Technicke sluzby"},
		{name: "Guma Usti s.r.o.", email: "info@guma-usti.test", ico: "12345613", region: "Usti nad Labem", size: "5-9", category: "Plasty > Gumovani vyrobky"},
		{name: "Jerabova Technika MB s.r.o.", email: "info@jerab-mb.test", ico: "12345614", region: "Mlada Boleslav", size: "10-49", category: "Strojirenstvi > Zdvihaci technika"},
		{name: "Pila Trutnov s.r.o.", email: "info@pila-trutnov.test", ico: "12345615", region: "Trutnov", size: "5-9", category: "Drevovyroba > Pila"},
		{name: "Agro Zlin a.s.", email: "info@agro-zlin.test", ico: "12345616", region: "Zlin", size: "50-99", category: "Zemedelstvi > Zivocisna vyroba"},
		{name: "Obrabeni Pardubice s.r.o.", email: "info@obrabeni-pardubice.test", ico: "12345617", region: "Pardubice", size: "10-49", category: "Strojirenstvi > Obrabeni kovu"},
		{name: "Svary KV s.r.o.", email: "info@svary-kv.test", ico: "12345618", region: "Karlovy Vary", size: "5-9", category: "Hutnictvi > Svarovani"},
		{name: "Logistika Brno s.r.o.", email: "info@logistika-brno.test", ico: "12345619", region: "Brno", size: "10-49", category: "Doprava > Logistika"},
		{name: "Farma Olomouc a.s.", email: "info@farma-olomouc.test", ico: "12345620", region: "Olomouc", size: "50-99", category: "Zemedelstvi > Zemedelska farma"},
	}
}
