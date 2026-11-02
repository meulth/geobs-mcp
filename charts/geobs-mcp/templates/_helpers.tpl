{{- define "geobs-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "geobs-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "geobs-mcp.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- define "geobs-mcp.configName" -}}
{{- printf "%s-config" (include "geobs-mcp.fullname" . | trunc 56 | trimSuffix "-") -}}
{{- end -}}
{{- define "geobs-mcp.claimName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-catalog" (include "geobs-mcp.fullname" . | trunc 55 | trimSuffix "-") -}}
{{- end -}}
{{- end -}}
{{- define "geobs-mcp.refreshName" -}}
{{- printf "%s-refresh" (include "geobs-mcp.fullname" . | trunc 44 | trimSuffix "-") -}}
{{- end -}}
{{- define "geobs-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "geobs-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "geobs-mcp.labels" -}}
{{ include "geobs-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}
{{- define "geobs-mcp.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}
{{- define "geobs-mcp.catalogPath" -}}
{{- printf "%s/%s" .Values.catalog.mountPath .Values.catalog.fileName -}}
{{- end -}}
{{- define "geobs-mcp.validate" -}}
{{- if not (has .Values.probes.host .Values.config.allowedHosts) -}}
{{- fail "probes.host must be present in config.allowedHosts" -}}
{{- end -}}
{{- if not (has "ReadWriteMany" .Values.persistence.accessModes) -}}
{{- if not .Values.persistence.allowSingleNodeAccess -}}
{{- fail "Shared app/CronJob catalog requires ReadWriteMany; ReadWriteOnce needs persistence.allowSingleNodeAccess=true and operator-enforced same-node scheduling" -}}
{{- end -}}
{{- if ne (int .Values.replicaCount) 1 -}}
{{- fail "Single-node ReadWriteOnce mode supports only replicaCount=1" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- define "geobs-mcp.podSettings" -}}
automountServiceAccountToken: false
{{- with .Values.serviceAccountName }}
serviceAccountName: {{ . | quote }}
{{- end }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
{{- end -}}
