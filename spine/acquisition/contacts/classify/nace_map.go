package classify

// Sector defines one industry sector with CZ-NACE prefix mapping.
type Sector struct {
	Code       string
	Label      string
	NACEPrefix []string
}

// Sectors defines all recognized business sectors.
// 4-digit sub-sectors MUST appear before their 2-digit parent sectors so that
// classifyByNACE assigns the more specific code as sector_primary.
var Sectors = []Sector{
	// === 4-DIGIT NACE SUB-SECTORS (precede 2-digit parents) ===
	{Code: "machinery_cnc", Label: "CNC obrábění", NACEPrefix: []string{"2562", "2811", "2840"}},
	{Code: "machinery_hydraulic", Label: "Hydraulika a pneumatika", NACEPrefix: []string{"2812", "2813"}},
	{Code: "machinery_agricultural", Label: "Zemědělská technika", NACEPrefix: []string{"2830"}},
	{Code: "metalwork_stamping", Label: "Lisování kovů", NACEPrefix: []string{"2550"}},
	{Code: "metalwork_casting", Label: "Slévárny", NACEPrefix: []string{"2451", "2452", "2453", "2454"}},
	{Code: "automotive_parts", Label: "Automotive díly", NACEPrefix: []string{"2931", "2932"}},
	{Code: "construction_civil", Label: "Inženýrské stavby", NACEPrefix: []string{"4211", "4212", "4213", "4221", "4222"}},
	{Code: "construction_specialized", Label: "Specializované stavby", NACEPrefix: []string{
		"4311", "4312", "4313", "4321", "4322", "4329", "4331", "4332", "4333", "4334", "4339", "4391", "4399",
	}},

	// === PRIMARY TARGET ===
	{Code: "machinery", Label: "Strojírenství", NACEPrefix: []string{"28", "3312", "3314", "3320"}},
	{Code: "metalwork", Label: "Kovovýroba", NACEPrefix: []string{"24", "25"}},
	{Code: "construction", Label: "Stavebnictví", NACEPrefix: []string{"41", "42", "43"}},
	// NACE 45: trade and repair of motor vehicles — car dealers, repair shops, parts importers
	{Code: "automotive", Label: "Automotive", NACEPrefix: []string{"29", "30", "45"}},
	{Code: "woodwork", Label: "Dřevozpracování", NACEPrefix: []string{"16", "31"}},
	{Code: "plastics", Label: "Plasty a guma", NACEPrefix: []string{"22"}},
	{Code: "food_processing", Label: "Potravinářství", NACEPrefix: []string{"10", "11"}},

	// === SECONDARY ===
	{Code: "agriculture", Label: "Zemědělství", NACEPrefix: []string{"01", "02", "03"}},
	// NACE 36: water collection/treatment, 37: sewerage, 36-39 = utilities cluster
	{Code: "energy", Label: "Energetika", NACEPrefix: []string{"35", "36", "37"}},
	{Code: "transport", Label: "Doprava a logistika", NACEPrefix: []string{"49", "50", "51", "52", "53"}},
	{Code: "waste", Label: "Odpady a recyklace", NACEPrefix: []string{"38", "39"}},
	{Code: "mining", Label: "Těžba", NACEPrefix: []string{"05", "06", "07", "08", "09"}},
	{Code: "chemicals", Label: "Chemie a farma", NACEPrefix: []string{"20", "21"}},
	{Code: "textiles", Label: "Textil a oděvy", NACEPrefix: []string{"13", "14", "15"}},
	// NACE 95: repair of computers and personal/household goods — electronic repair workshops
	{Code: "electronics", Label: "Elektronika", NACEPrefix: []string{"26", "27", "95"}},
	{Code: "printing", Label: "Polygrafie", NACEPrefix: []string{"17", "18"}},
	{Code: "manufacturing", Label: "Výroba ostatní", NACEPrefix: []string{"12", "19", "23", "32", "33"}},

	// === TERTIARY ===
	{Code: "it", Label: "IT a software", NACEPrefix: []string{"62", "63"}},
	{Code: "wholesale", Label: "Velkoobchod", NACEPrefix: []string{"46"}},
	{Code: "retail", Label: "Maloobchod", NACEPrefix: []string{"47"}},
	{Code: "real_estate", Label: "Nemovitosti", NACEPrefix: []string{"68"}},
	{Code: "finance", Label: "Finance", NACEPrefix: []string{"64", "65", "66"}},
	{Code: "hospitality", Label: "Ubytování a gastro", NACEPrefix: []string{"55", "56"}},
	{Code: "health", Label: "Zdravotnictví", NACEPrefix: []string{"86", "87", "88"}},
	{Code: "education", Label: "Vzdělávání", NACEPrefix: []string{"85"}},
	{Code: "professional", Label: "Profesní služby", NACEPrefix: []string{"69", "70", "71", "72", "73", "74", "75"}},
	{Code: "telecom", Label: "Telekomunikace", NACEPrefix: []string{"61"}},

	// === ANTI-TARGET SECTORS (classifier recognizes them so ICP can gate them down) ===
	// These have empty NACEPrefix lists because they are matched by category slug,
	// not by NACE prefix. Their presence here just makes them known sector codes
	// so TagCodes() produces a value that AntiTargetSectors can test against.
	{Code: "adult", Label: "Erotika a adult", NACEPrefix: nil},
	{Code: "tourism", Label: "Cestovní ruch", NACEPrefix: nil},
	{Code: "personal_services", Label: "Osobní služby", NACEPrefix: nil},
}

// AntiTargetSectors is the set of sector codes that are structurally wrong for a
// heavy-machinery dealer (excavators, wheel loaders, cranes, agricultural
// equipment). A company tagged with any of these sectors MUST be capped at the
// "irrelevant" tier regardless of size, data completeness, rating, age, or legal
// form — industry fit is necessary, not optional. See
// [CalculateICPWithFactors] for the capping logic and
// internal/classify/icp_realism_test.go for the acceptance baseline.
var AntiTargetSectors = map[string]bool{
	"retail":            true,
	"hospitality":       true,
	"real_estate":       true,
	"finance":           true,
	"it":                true,
	"professional":      true,
	"health":            true,
	"education":         true,
	"personal_services": true,
	"adult":             true,
	"tourism":           true,
}

// SectorKeywords maps sector codes to Czech keyword stems.
var SectorKeywords = map[string][]string{
	"machinery": {
		"stroj", "strojír", "strojní", "obráběn", "cnc", "fréz", "soustruh",
		"lis", "čerpadl", "kompresor", "hydraul", "pneumat", "převodov",
		"řezán", "brusn", "vrtačk", "jeřáb", "zdvihad",
	},
	"metalwork": {
		"kovov", "svařov", "zámečn", "ocel", "hliník", "plech",
		"pozink", "tryskán", "žárov", "kovoobrábě", "nástrojář",
	},
	"construction": {
		"stavb", "staveb", "stavěn", "zednic", "betonár", "fasád", "izolac",
		"zateplen", "střech", "tesař", "pokrývač", "podlah", "obklad",
		"demolič", "bagr", "buldozer", "zemní práce",
	},
	"automotive": {
		"auto", "vozidl", "servis aut", "pneu", "karoser", "autolak",
		"autoelektri", "náhradní díly",
	},
	"woodwork": {
		"dřev", "truhlář", "pila", "řezivo", "nábytek", "dýh",
		"palety", "euro palety",
	},
	"plastics": {
		"plast", "polyethyl", "vstřikov", "extruze", "polypropylen",
		"termoplast", "laminát", "kompozit",
	},
	"food_processing": {
		"potravin", "pekár", "mlékár", "masn", "jateční",
		"konzerv", "balírn", "plnírn", "cukrov",
	},
	"agriculture": {
		"zeměděl", "agro", "traktor", "kombajn", "sklizeň", "osivo",
		"hnojiv", "postřik", "živočiš", "chov", "rostlin", "farma",
		"lesnict",
	},
	"energy": {
		"energ", "solár", "fotovolt", "tepeln", "kotel", "vytápěn",
		"klimatizac", "vzduchotechni", "elektroinstal",
	},
	"transport": {
		"doprav", "přeprav", "kamion", "logist", "spedic", "silnič",
		"nákladn", "cistern", "přívěs", "návěs", "tahač",
	},
	"waste": {
		"odpad", "recykl", "sběrn", "likvidac", "skládk", "třídění",
	},
	"chemicals": {
		"chemick", "chemie", "farma", "léčiv", "laborat", "reagen",
	},
	"electronics": {
		"elektron", "elektrotechn", "kabel", "vodič", "senzor",
	},
	"mining": {
		"důl", "těžb", "lom", "písk", "štěrk", "kámen",
	},
	"it": {
		"software", "programov", "aplikac", "systém", "databáz",
	},
}
