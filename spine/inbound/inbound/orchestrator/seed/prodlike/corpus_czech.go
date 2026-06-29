package prodlike

// This file holds public-domain Czech-language corpora used to generate
// synthetic personal and geographic data. The lists are based on
// publicly available ČSÚ (Czech Statistical Office) frequency tables
// for names, surnames and municipalities — no real personal data from
// production is present.
//
// Synthetic combinations are highly unlikely to match any real person
// but callers should still treat these as test data, not PII.

// MaleFirstNames contains 100 common Czech male first names, roughly
// frequency-sorted (most common first).
var MaleFirstNames = []string{
	"Jan", "Jiří", "Petr", "Josef", "Pavel", "Martin", "Tomáš", "Jaroslav",
	"Miroslav", "František", "Zdeněk", "Václav", "Michal", "Milan", "Karel",
	"Vladimír", "Lukáš", "David", "Ladislav", "Roman",
	"Stanislav", "Ondřej", "Marek", "Radek", "Jakub",
	"Antonín", "Vojtěch", "Daniel", "Rudolf", "Adam",
	"Matěj", "Filip", "Bohumil", "Libor", "Patrik",
	"Štefan", "Oldřich", "Jiřík", "Viktor", "Bohuslav",
	"Ivan", "Rostislav", "Miloslav", "Alois", "Miloš",
	"Aleš", "Emil", "Luděk", "Richard", "Radim",
	"Dalibor", "Robert", "Ivo", "Michael", "Dominik",
	"Štěpán", "Kryštof", "Matyáš", "Igor", "Oskar",
	"Bedřich", "Eduard", "Augustin", "Alexandr", "Arnošt",
	"Boris", "Cyril", "Čeněk", "Dušan", "Dušan",
	"Ervín", "Evžen", "Gustav", "Hubert", "Ignác",
	"Imrich", "Jindřich", "Julián", "Kamil", "Klement",
	"Konstantin", "Leopold", "Leoš", "Maxmilián", "Metoděj",
	"Mikuláš", "Milan", "Mojmír", "Nikolas", "Oleg",
	"Otakar", "Přemysl", "Radomír", "Rafael", "René",
	"Ruslan", "Samuel", "Šimon", "Teodor", "Vilém",
	"Vincenc", "Vít", "Vladislav", "Vratislav", "Xaver",
}

// FemaleFirstNames contains 100 common Czech female first names.
var FemaleFirstNames = []string{
	"Marie", "Jana", "Eva", "Anna", "Hana",
	"Lenka", "Kateřina", "Věra", "Alena", "Petra",
	"Lucie", "Jaroslava", "Martina", "Helena", "Zuzana",
	"Jitka", "Michaela", "Veronika", "Ludmila", "Jarmila",
	"Tereza", "Ivana", "Barbora", "Jiřina", "Dagmar",
	"Monika", "Nikola", "Pavla", "Kristýna", "Zdeňka",
	"Klára", "Eliška", "Markéta", "Dana", "Marcela",
	"Růžena", "Květa", "Irena", "Naděžda", "Simona",
	"Šárka", "Libuše", "Olga", "Miroslava", "Renata",
	"Romana", "Blanka", "Adéla", "Gabriela", "Denisa",
	"Sára", "Natálie", "Vlasta", "Vladimíra", "Bohumila",
	"Tereza", "Daniela", "Andrea", "Iveta", "Magdaléna",
	"Kamila", "Radka", "Stanislava", "Drahomíra", "Elena",
	"Agáta", "Alena", "Alžběta", "Aneta", "Antonie",
	"Beata", "Bianka", "Božena", "Cecílie", "Darina",
	"Diana", "Ema", "Emilie", "Ester", "Františka",
	"Hedvika", "Ida", "Ingrid", "Izabela", "Julie",
	"Karolína", "Klaudie", "Květoslava", "Lada", "Laura",
	"Libuše", "Linda", "Liliana", "Lýdie", "Magda",
	"Mirka", "Miluše", "Nela", "Olívie", "Pavlína",
}

// CzechSurnames contains 500 common Czech surnames, selected from the
// most-frequent bucket of the ČSÚ register. All are public-domain family
// names. Both masculine and feminine forms appear where both are common.
var CzechSurnames = []string{
	"Novák", "Novotný", "Svoboda", "Dvořák", "Černý",
	"Procházka", "Kučera", "Veselý", "Horák", "Němec",
	"Pokorný", "Pospíšil", "Hájek", "Jelínek", "Růžička",
	"Beneš", "Fiala", "Sedláček", "Doležal", "Zeman",
	"Kolář", "Navrátil", "Čermák", "Urban", "Vaněk",
	"Blažek", "Kříž", "Kovář", "Říha", "Polák",
	"Bartoš", "Moravec", "Šimek", "Konečný", "Soukup",
	"Král", "Kadlec", "Beránek", "Štěpánek", "Holub",
	"Čech", "Staněk", "Kříž", "Jandák", "Vlček",
	"Matoušek", "Tichý", "Štěrba", "Kubát", "Brož",
	"Richter", "Malý", "Hruška", "Bláha", "Straka",
	"Hlaváček", "Vávra", "Procházková", "Novotná", "Svobodová",
	"Dvořáková", "Černá", "Kučerová", "Veselá", "Horáková",
	"Němcová", "Pokorná", "Hájková", "Jelínková", "Růžičková",
	"Benešová", "Fialová", "Sedláčková", "Doležalová", "Zemanová",
	"Kolářová", "Navrátilová", "Čermáková", "Urbanová", "Vaňková",
	"Blažková", "Křížová", "Kovářová", "Říhová", "Poláková",
	"Bartošová", "Moravcová", "Šimková", "Konečná", "Soukupová",
	"Králová", "Kadlecová", "Beránková", "Štěpánková", "Holubová",
	"Matoušková", "Malá", "Hrušková", "Bláhová", "Straková",
	"Krejčí", "Hrabalová", "Zima", "Burda", "Pospíchal",
	"Janda", "Dolejš", "Kopecký", "Janoušek", "Tesař",
	"Hrubý", "Slaný", "Vítek", "Votava", "Bouška",
	"Kalous", "Ryšavý", "Bednář", "Adámek", "Rous",
	"Kotek", "Škoda", "Válek", "Houdek", "Brych",
	"Mrkvička", "Havlíček", "Havel", "Hladík", "Mareš",
	"Bořík", "Linhart", "Kašpar", "Hanuš", "Havlík",
	"Ryba", "Valenta", "Pícha", "Burian", "Kučírek",
	"Toman", "Vlk", "Skála", "Duda", "Diviš",
	"Kopřiva", "Franke", "Samek", "Bárta", "Máca",
	"Stehlík", "Žďárský", "Hynek", "Liška", "Zajíc",
	"Halík", "Zvolánek", "Mašek", "Bureš", "Kratochvíl",
	"Musil", "Klimeš", "Hofman", "Hájková", "Vrba",
	"Poupa", "Matyáš", "Bojanovský", "Oplt", "Cibulka",
	"Sýkora", "Brožek", "Novotná", "Mikulka", "Janík",
	"Hrbek", "Kudrna", "Doubek", "Polanský", "Vajda",
	"Hanzl", "Chaloupka", "Čapek", "Vaňhara", "Filípek",
	"Tichý", "Drahota", "Pazderka", "Jirásek", "Štěpán",
	"Kolínský", "Rohlík", "Kohout", "Krampera", "Rychnovský",
	"Holeček", "Krejca", "Pinta", "Strnad", "Škorpil",
	"Barták", "Strouhal", "Hlaváč", "Matějček", "Švéda",
	"Janáček", "Holeček", "Kohoutek", "Slavík", "Kohoutek",
	"Dohnal", "Slezák", "Vítek", "Šulc", "Čapek",
	"Rohlík", "Kolář", "Koubek", "Tvrdík", "Plachý",
	"Málek", "Maxa", "Holý", "Jelen", "Havranek",
	"Bašta", "Rezek", "Vraný", "Klíma", "Kubeš",
	"Valenta", "Lukáš", "Janouš", "Žáček", "Bouček",
	"Štípek", "Štolba", "Janošík", "Veselka", "Drápela",
	"Drápal", "Drastík", "Dudek", "Duchoň", "Duchoslav",
	"Dušek", "Dvorský", "Eremiáš", "Fanta", "Fencl",
	"Ferda", "Formánek", "Fousek", "Fráňa", "Frank",
	"Frgal", "Friedl", "Frolík", "Frýba", "Fuchs",
	"Funda", "Gargulák", "Geršl", "Gondek", "Gross",
	"Gruber", "Gurka", "Habada", "Habala", "Haber",
	"Hadač", "Hadrava", "Hajný", "Halama", "Halík",
	"Hamata", "Hampl", "Hanč", "Hanzal", "Harašta",
	"Hartman", "Hašek", "Hausner", "Hauzr", "Havlena",
	"Havlín", "Havrda", "Hejcman", "Hejduk", "Hejl",
	"Hejna", "Hekrdla", "Helcl", "Hellebrand", "Herčík",
	"Herian", "Herink", "Hermach", "Heřmánek", "Hess",
	"Hladký", "Hlas", "Hlaváček", "Hlína", "Hodek",
	"Hodinář", "Hoffman", "Holan", "Holcman", "Holčík",
	"Holeček", "Holík", "Holík", "Holinka", "Hollas",
	"Holman", "Holoubek", "Holub", "Honek", "Honsa",
	"Hora", "Horčička", "Horeček", "Hork", "Horký",
	"Horn", "Horník", "Horynová", "Hošek", "Hoška",
	"Hošna", "Houba", "Houdek", "Houžvička", "Hrabák",
	"Hrabal", "Hrabě", "Hrách", "Hrdý", "Hrobský",
	"Hromek", "Hronek", "Hrouda", "Hruboš", "Hrubý",
	"Hrušovský", "Hudec", "Hulec", "Hušek", "Huťák",
	"Hýbner", "Hynek", "Chalupa", "Charvát", "Chasák",
	"Chalupa", "Chládek", "Chlad", "Chlup", "Chmelář",
	"Choc", "Chocholatý", "Chocholoušek", "Cholevík", "Chotek",
	"Chrást", "Christov", "Chudoba", "Chval", "Chvátal",
	"Chvojka", "Chytil", "Chytra", "Illek", "Imrich",
	"Indra", "Irovský", "Isakov", "Išev", "Ivanov",
	"Ivon", "Jablonský", "Jágr", "Jakes", "Jakl",
	"Jakoubek", "Jakubík", "Jakubovský", "Janásek", "Janata",
	"Janča", "Jančo", "Janeček", "Janek", "Janíček",
	"Janík", "Janouš", "Janšta", "Jansta", "Janura",
	"Jar", "Jaroš", "Jasanský", "Jáska", "Jech",
	"Jedlan", "Jehlík", "Jelen", "Jeník", "Jenček",
	"Jeřábek", "Ježek", "Jíra", "Jirásek", "Jiřík",
	"Jirman", "Jirsák", "Jíšová", "Jůza", "Kabát",
	"Kadera", "Kafka", "Kaláb", "Kalaš", "Kalus",
	"Kaňka", "Kaplan", "Karban", "Kasal", "Kaše",
	"Kepák", "Klapka", "Klapuch", "Klášterka", "Klečka",
	"Klein", "Klenka", "Klepáček", "Klíma", "Klíž",
	"Klodner", "Kloubek", "Kluska", "Kmoch", "Knaibl",
	"Kobliha", "Kodýtek", "Koch", "Kochán", "Kocián",
	"Kodytek", "Kolací", "Kolář", "Kolařík", "Kolejka",
	"Kolínský", "Kolman", "Komarek", "Komenda", "Komín",
	"Konečník", "Konopa", "Konopka", "Konůpek", "Kopač",
	"Kopecký", "Kopičera", "Kopka", "Koppo", "Korba",
	"Koreček", "Korf", "Kormunda", "Koronthaly", "Košťál",
	"Kotek", "Kotík", "Kotlík", "Kotlín", "Kotrba",
	"Kott", "Koubek", "Koutná", "Kouřil", "Kovanda",
	"Kovář", "Kozák", "Krajíček", "Krákora", "Král",
	"Králík", "Kramář", "Krása", "Kratochvíl", "Krauz",
	"Krejčí", "Krejčík", "Krejcar", "Kříž", "Křížek",
}

// CzechCities contains 100 Czech cities and municipalities with
// approximate weight (relative population). The Praha variants below are
// deliberately expanded because production firmy-cz data splits Praha
// into neighbourhood labels ("Praha, Vinohrady", "Praha, Smíchov", ...).
type CityWeight struct {
	Name   string
	Weight int // relative; sum is not normalised
}

var CzechCities = []CityWeight{
	// Praha variants — collectively ~15 % of prod firmy rows
	{"Praha", 170},
	{"Praha, Nové Město", 120},
	{"Praha, Vinohrady", 80},
	{"Praha, Žižkov", 60},
	{"Praha, Staré Město", 55},
	{"Praha, Smíchov", 50},
	{"Praha, Holešovice", 45},
	{"Praha, Libeň", 40},
	{"Praha, Nusle", 35},
	{"Praha, Stodůlky", 30},
	{"Praha, Karlín", 30},
	{"Praha, Dejvice", 28},
	{"Praha, Vršovice", 25},
	{"Praha, Braník", 22},
	{"Praha, Břevnov", 20},

	// Major regional cities
	{"Brno", 180},
	{"Ostrava", 90},
	{"Plzeň", 75},
	{"Liberec", 45},
	{"Olomouc", 55},
	{"České Budějovice", 50},
	{"Hradec Králové", 48},
	{"Ústí nad Labem", 40},
	{"Pardubice", 42},
	{"Zlín", 75},

	// Secondary cities
	{"Havířov", 30},
	{"Kladno", 35},
	{"Most", 25},
	{"Opava", 28},
	{"Frýdek-Místek", 27},
	{"Karviná", 25},
	{"Jihlava", 55},
	{"Teplice", 22},
	{"Karlovy Vary", 28},
	{"Chomutov", 18},
	{"Jablonec nad Nisou", 18},
	{"Mladá Boleslav", 28},
	{"Prostějov", 22},
	{"Přerov", 20},
	{"Česká Lípa", 15},
	{"Třebíč", 14},
	{"Třinec", 16},
	{"Tábor", 17},
	{"Znojmo", 16},
	{"Příbram", 18},
	{"Orlová", 12},
	{"Cheb", 14},
	{"Kolín", 14},
	{"Trutnov", 15},
	{"Písek", 14},
	{"Kroměříž", 13},
	{"Šumperk", 13},
	{"Vsetín", 13},
	{"Uherské Hradiště", 14},
	{"Břeclav", 13},
	{"Hodonín", 13},
	{"Český Těšín", 11},
	{"Litvínov", 10},
	{"Nový Jičín", 11},
	{"Havlíčkův Brod", 12},

	// Smaller towns (Long tail)
	{"Krnov", 8}, {"Strakonice", 9}, {"Klatovy", 9},
	{"Kopřivnice", 8}, {"Bohumín", 8}, {"Jirkov", 8},
	{"Litoměřice", 9}, {"Valašské Meziříčí", 8}, {"Benešov", 9},
	{"Žatec", 7}, {"Beroun", 8}, {"Česká Třebová", 7},
	{"Rakovník", 7}, {"Jindřichův Hradec", 8}, {"Náchod", 8},
	{"Svitavy", 7}, {"Bruntál", 7}, {"Hranice", 6},
	{"Uherský Brod", 7}, {"Rožnov pod Radhoštěm", 7},
	{"Mělník", 8}, {"Chrudim", 8}, {"Kutná Hora", 7},
	{"Vyškov", 8}, {"Český Krumlov", 7}, {"Jičín", 7},
	{"Turnov", 6}, {"Domažlice", 6}, {"Říčany", 7},
	{"Roudnice nad Labem", 6}, {"Kladruby", 4}, {"Neratovice", 5},
	{"Prachatice", 5}, {"Poděbrady", 6}, {"Nymburk", 6},
	{"Uničov", 5}, {"Vrchlabí", 5}, {"Sokolov", 8},
	{"Blansko", 6}, {"Kralupy nad Vltavou", 5}, {"Litomyšl", 5},
}

// ensureCorpusInvariants is a compile-time assertion that the slices
// have at least the documented minimums. Called from tests.
func ensureCorpusInvariants() (ok bool, first, last, cities int) {
	first = len(MaleFirstNames) + len(FemaleFirstNames)
	last = len(CzechSurnames)
	cities = len(CzechCities)
	ok = first >= 200 && last >= 500 && cities >= 100
	return
}
