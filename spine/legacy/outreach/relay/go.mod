module relay

go 1.25.5

require common v0.0.0

require (
	github.com/getsentry/sentry-go v0.46.0 // indirect
	golang.org/x/sys v0.43.0 // indirect
	golang.org/x/text v0.36.0 // indirect
)

replace common => ../../platform/common
