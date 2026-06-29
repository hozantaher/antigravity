package envconfig_test

import (
	"os"
	"testing"

	"common/envconfig"
)

func TestRequired_AllPresent_NoMissing(t *testing.T) {
	t.Setenv("FOO", "1")
	t.Setenv("BAR", "2")
	s := envconfig.Required("FOO", "BAR")
	if missing := envconfig.Validate(s); len(missing) != 0 {
		t.Errorf("expected no missing, got %v", missing)
	}
}

func TestRequired_SomeMissing_Reported(t *testing.T) {
	os.Unsetenv("FOO_NOT_SET_999")
	t.Setenv("BAR_SET_777", "yes")
	s := envconfig.Required("FOO_NOT_SET_999", "BAR_SET_777")
	missing := envconfig.Validate(s)
	if len(missing) != 1 || missing[0] != "FOO_NOT_SET_999" {
		t.Errorf("expected [FOO_NOT_SET_999], got %v", missing)
	}
}

func TestRequired_EmptyStringTreatedAsMissing(t *testing.T) {
	t.Setenv("EMPTY_VAR_555", "")
	s := envconfig.Required("EMPTY_VAR_555")
	missing := envconfig.Validate(s)
	if len(missing) != 1 {
		t.Errorf("expected empty string to count as missing, got %v", missing)
	}
}

func TestRequired_WhitespaceTreatedAsMissing(t *testing.T) {
	t.Setenv("WS_VAR_111", "   ")
	s := envconfig.Required("WS_VAR_111")
	missing := envconfig.Validate(s)
	if len(missing) != 1 {
		t.Errorf("expected whitespace to count as missing, got %v", missing)
	}
}

func TestOptionalDefault_FillsMissing(t *testing.T) {
	os.Unsetenv("OPT_222")
	s := envconfig.Required()
	envconfig.OptionalDefault(&s, "OPT_222", "default-value")
	if got := os.Getenv("OPT_222"); got != "default-value" {
		t.Errorf("got %q, want default-value", got)
	}
}

func TestOptionalDefault_PreservesExisting(t *testing.T) {
	t.Setenv("OPT_333", "user-supplied")
	s := envconfig.Required()
	envconfig.OptionalDefault(&s, "OPT_333", "default-value")
	if got := os.Getenv("OPT_333"); got != "user-supplied" {
		t.Errorf("got %q, want user-supplied (default must not overwrite)", got)
	}
}

func TestRequired_ZeroVarsAlwaysOK(t *testing.T) {
	s := envconfig.Required()
	if missing := envconfig.Validate(s); len(missing) != 0 {
		t.Errorf("zero requireds should pass validation, got %v", missing)
	}
}

func TestGetOr(t *testing.T) {
	cases := []struct {
		name, key, set, fallback, want string
		unset                          bool
	}{
		{name: "missing returns fallback", key: "GETOR_MISS_1", unset: true, fallback: "fb", want: "fb"},
		{name: "empty returns fallback", key: "GETOR_EMPTY_1", set: "", fallback: "fb", want: "fb"},
		{name: "value present overrides fallback", key: "GETOR_SET_1", set: "real", fallback: "fb", want: "real"},
		{name: "whitespace value is preserved", key: "GETOR_WS_1", set: "   ", fallback: "fb", want: "   "},
		{name: "fallback empty allowed", key: "GETOR_NOFB_1", unset: true, fallback: "", want: ""},
		{name: "unicode preserved", key: "GETOR_UNI_1", set: "Příliš žluťoučký", fallback: "fb", want: "Příliš žluťoučký"},
		{name: "spaces around value preserved", key: "GETOR_PAD_1", set: " v ", fallback: "fb", want: " v "},
		{name: "tab value preserved", key: "GETOR_TAB_1", set: "\tv", fallback: "fb", want: "\tv"},
		{name: "newline value preserved", key: "GETOR_NL_1", set: "v\n", fallback: "fb", want: "v\n"},
		{name: "numeric string preserved", key: "GETOR_NUM_1", set: "42", fallback: "fb", want: "42"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.unset {
				os.Unsetenv(tc.key)
			} else {
				t.Setenv(tc.key, tc.set)
			}
			if got := envconfig.GetOr(tc.key, tc.fallback); got != tc.want {
				t.Errorf("GetOr(%q, %q) = %q, want %q", tc.key, tc.fallback, got, tc.want)
			}
		})
	}
}

func TestBoolOr(t *testing.T) {
	cases := []struct {
		name, key, set string
		fallback, want bool
		unset          bool
	}{
		// truthy aliases
		{name: "1 → true", key: "BOOLOR_1A", set: "1", fallback: false, want: true},
		{name: "true → true", key: "BOOLOR_1B", set: "true", fallback: false, want: true},
		{name: "TRUE → true (case-insensitive)", key: "BOOLOR_1C", set: "TRUE", fallback: false, want: true},
		{name: "True → true", key: "BOOLOR_1D", set: "True", fallback: false, want: true},
		{name: "yes → true", key: "BOOLOR_1E", set: "yes", fallback: false, want: true},
		{name: "YES → true", key: "BOOLOR_1F", set: "YES", fallback: false, want: true},
		{name: "on → true", key: "BOOLOR_1G", set: "on", fallback: false, want: true},
		{name: "padded yes → fallback (whitespace rejected)", key: "BOOLOR_1H", set: "  yes  ", fallback: false, want: false},
		// falsy aliases
		{name: "0 → false", key: "BOOLOR_2A", set: "0", fallback: true, want: false},
		{name: "false → false", key: "BOOLOR_2B", set: "false", fallback: true, want: false},
		{name: "FALSE → false", key: "BOOLOR_2C", set: "FALSE", fallback: true, want: false},
		{name: "no → false", key: "BOOLOR_2D", set: "no", fallback: true, want: false},
		{name: "off → false", key: "BOOLOR_2E", set: "off", fallback: true, want: false},
		// fallback paths
		{name: "missing → fallback (true)", key: "BOOLOR_3A", unset: true, fallback: true, want: true},
		{name: "missing → fallback (false)", key: "BOOLOR_3B", unset: true, fallback: false, want: false},
		{name: "empty → fallback", key: "BOOLOR_3C", set: "", fallback: true, want: true},
		{name: "whitespace-only → fallback", key: "BOOLOR_3D", set: "   ", fallback: true, want: true},
		{name: "unknown alias → fallback", key: "BOOLOR_3E", set: "maybe", fallback: true, want: true},
		{name: "garbage → fallback (false)", key: "BOOLOR_3F", set: "xxx", fallback: false, want: false},
		{name: "t (single char) → fallback (rejected)", key: "BOOLOR_3G", set: "t", fallback: false, want: false},
		{name: "f (single char) → fallback (rejected)", key: "BOOLOR_3H", set: "f", fallback: true, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.unset {
				os.Unsetenv(tc.key)
			} else {
				t.Setenv(tc.key, tc.set)
			}
			if got := envconfig.BoolOr(tc.key, tc.fallback); got != tc.want {
				t.Errorf("BoolOr(%q, fallback=%v) with set=%q = %v, want %v",
					tc.key, tc.fallback, tc.set, got, tc.want)
			}
		})
	}
}
