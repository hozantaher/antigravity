package prospect

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"contacts/contact"
	"strings"
)

// FirmyFilter defines criteria for selecting businesses from firmy-cz.
type FirmyFilter struct {
	Region      string // address_locality ILIKE filter
	HasEmail    bool   // only businesses with email
	HasPhone    bool   // only businesses with telephone
	HasICO      bool   // only businesses with ICO
	MinRating   float64
	Categories  string // categories_json ILIKE filter
	Description string // description ILIKE filter
	Limit       int
	Offset      int
	AfterID     int  // cursor-based pagination: WHERE id > AfterID (preferred over Offset for large tables)
}

// FirmyBusiness represents a row from firmy_cz_businesses.
type FirmyBusiness struct {
	ID             int
	Name           string
	Email          string
	Telephone      string
	ICO            string
	Website        string
	Region         string
	StreetAddress  string
	PostalCode     string
	Description    string
	VelikostFirmy  string
	PravniForma    string
	CategoryPath   string
	CategoriesJSON string // raw JSON: [{"name":"Czech category name","url":"..."}]
	RatingValue    float64
	RatingCount    int
}

// FirmySource reads from the Railway Postgres firmy-cz database.
type FirmySource struct {
	db *sql.DB
}

// NewFirmySource connects to the firmy-cz Railway Postgres.
func NewFirmySource(dsn string) (*FirmySource, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("connect to firmy-cz: %w", err)
	}
	db.SetMaxOpenConns(5)

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping firmy-cz: %w", err)
	}

	return &FirmySource{db: db}, nil
}

// Close closes the firmy-cz database connection.
func (f *FirmySource) Close() {
	f.db.Close()
}

// Count returns the number of businesses matching the filter.
func (f *FirmySource) Count(ctx context.Context, filter FirmyFilter) (int, error) {
	countFilter := filter
	countFilter.Limit = 0
	countFilter.Offset = 0
	query, args := buildCountQuery(countFilter)
	var count int
	err := f.db.QueryRowContext(ctx, query, args...).Scan(&count)
	return count, err
}

// Fetch returns businesses matching the filter.
func (f *FirmySource) Fetch(ctx context.Context, filter FirmyFilter) ([]FirmyBusiness, error) {
	cols := `id, name, email, telephone, ico, website,
		address_locality, street_address, postal_code,
		description, velikost_firmy, pravni_forma, category_path,
		COALESCE(category_path, ''),
		COALESCE(rating_value, 0), COALESCE(rating_count, 0)`

	query, args := buildQuery("SELECT "+cols, filter)

	rows, err := f.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query firmy-cz: %w", err)
	}
	defer rows.Close()

	var results []FirmyBusiness
	for rows.Next() {
		var b FirmyBusiness
		var name, email, telephone, ico, website sql.NullString
		var region, street, postal, desc, velFirmy, pravniForma, catPath sql.NullString

		err := rows.Scan(
			&b.ID,
			&name, &email, &telephone, &ico, &website,
			&region, &street, &postal,
			&desc, &velFirmy, &pravniForma, &catPath,
			&b.CategoriesJSON,
			&b.RatingValue, &b.RatingCount,
		)
		if err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}

		b.Name = nullStr(name)
		b.Email = nullStr(email)
		b.Telephone = nullStr(telephone)
		b.ICO = nullStr(ico)
		b.Website = nullStr(website)
		b.Region = nullStr(region)
		b.StreetAddress = nullStr(street)
		b.PostalCode = nullStr(postal)
		b.Description = nullStr(desc)
		b.VelikostFirmy = nullStr(velFirmy)
		b.PravniForma = nullStr(pravniForma)
		b.CategoryPath = nullStr(catPath)

		results = append(results, b)
	}

	return results, rows.Err()
}

// ImportToStore imports filtered firmy-cz businesses into the outreach contact store.
func (f *FirmySource) ImportToStore(ctx context.Context, store *contact.Store, filter FirmyFilter) (imported, skipped int, err error) {
	businesses, err := f.Fetch(ctx, filter)
	if err != nil {
		return 0, 0, err
	}

	slog.Info("prospect fetched businesses from firmy-cz, importing", "count", len(businesses))

	var contacts []contact.Contact
	for _, b := range businesses {
		if b.Email == "" {
			skipped++
			continue
		}

		firstName := extractFirstName(b.Name)

		contacts = append(contacts, contact.Contact{
			Email:       b.Email,
			FirstName:   firstName,
			CompanyName: b.Name,
			ICO:         b.ICO,
			Region:      b.Region,
			CompanySize: b.VelikostFirmy,
			Source:      "firmy-cz",
		})
	}

	result, err := store.BulkImport(ctx, contacts)
	if err != nil {
		if result == nil {
			return 0, skipped, err
		}
		return result.Imported, skipped + len(result.Skipped), err
	}
	return result.Imported, skipped + len(result.Skipped), nil
}

func buildCountQuery(filter FirmyFilter) (string, []any) {
	conditions, args := buildConditions(filter)
	query := "SELECT COUNT(*) FROM firmy_cz_businesses WHERE 1=1"
	for _, c := range conditions {
		query += " AND " + c
	}
	return query, args
}

func buildConditions(filter FirmyFilter) ([]string, []any) {
	var conditions []string
	var args []any
	argIdx := 1

	if filter.HasEmail {
		conditions = append(conditions, "email IS NOT NULL")
	}
	if filter.HasPhone {
		conditions = append(conditions, "telephone IS NOT NULL")
	}
	if filter.HasICO {
		conditions = append(conditions, "ico IS NOT NULL")
	}
	if filter.Region != "" {
		conditions = append(conditions, fmt.Sprintf("address_locality ILIKE $%d", argIdx))
		args = append(args, "%"+filter.Region+"%")
		argIdx++
	}
	if filter.Description != "" {
		conditions = append(conditions, fmt.Sprintf("description ILIKE $%d", argIdx))
		args = append(args, "%"+filter.Description+"%")
		argIdx++
	}
	if filter.Categories != "" {
		conditions = append(conditions, fmt.Sprintf("category_path ILIKE $%d", argIdx))
		args = append(args, "%"+filter.Categories+"%")
		argIdx++
	}
	if filter.MinRating > 0 {
		conditions = append(conditions, fmt.Sprintf("rating_value >= $%d", argIdx))
		args = append(args, filter.MinRating)
		argIdx++
	}
	// Cursor-based pagination: more efficient than OFFSET on large tables.
	// AfterID takes precedence; Offset is used as fallback when AfterID == 0.
	if filter.AfterID > 0 {
		conditions = append(conditions, fmt.Sprintf("id > $%d", argIdx))
		args = append(args, filter.AfterID)
	}

	return conditions, args
}

// MaxID returns the largest id in a set of FirmyBusiness rows.
func MaxID(businesses []FirmyBusiness) int {
	max := 0
	for _, b := range businesses {
		if b.ID > max {
			max = b.ID
		}
	}
	return max
}

func buildQuery(selectClause string, filter FirmyFilter) (string, []any) {
	conditions, args := buildConditions(filter)
	argIdx := len(args) + 1

	query := selectClause + " FROM firmy_cz_businesses WHERE 1=1"
	for _, c := range conditions {
		query += " AND " + c
	}

	query += " ORDER BY id"

	limit := filter.Limit
	if limit <= 0 {
		limit = 1000
	}
	query += fmt.Sprintf(" LIMIT $%d", argIdx)
	args = append(args, limit)
	argIdx++

	if filter.Offset > 0 {
		query += fmt.Sprintf(" OFFSET $%d", argIdx)
		args = append(args, filter.Offset)
	}

	return query, args
}

func nullStr(ns sql.NullString) string {
	if ns.Valid {
		return ns.String
	}
	return ""
}

func extractFirstName(companyName string) string {
	// Try to extract a person's first name from business name
	// e.g. "Ing. Jan Novák - poradenství" → "Jan"
	// For company names like "BIONA s.r.o." → ""
	parts := strings.Fields(companyName)
	if len(parts) < 2 {
		return ""
	}

	// Skip titles
	titles := map[string]bool{
		"Ing.": true, "ing.": true, "Mgr.": true, "mgr.": true,
		"Bc.": true, "bc.": true, "MUDr.": true, "JUDr.": true,
		"PhDr.": true, "RNDr.": true, "doc.": true, "prof.": true,
	}

	for _, p := range parts {
		if titles[p] {
			continue
		}
		// If it looks like a first name (capitalized, not all-caps company)
		if len(p) > 1 && p[0] >= 'A' && p[0] <= 'Z' && strings.ToUpper(p) != p {
			return p
		}
		break
	}

	return ""
}
