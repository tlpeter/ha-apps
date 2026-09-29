# Blueprint Builder (Home Assistant add-on)

Wizard in de HA-zijbalk die blueprints maakt op basis van templates, met vragen die rekening houden met de entities in jouw Home Assistant.

**Vereist:** Home Assistant OS of Supervised (add-ons werken niet op HA Container/Core).

## Installeren als lokale add-on

1. Installeer de add-on **Samba share** (of **Terminal & SSH**) als je die nog niet hebt.
2. Kopieer de map `blueprint_builder` naar de share **addons**, zodat je krijgt:
   ```
   /addons/blueprint_builder/config.yaml
   /addons/blueprint_builder/Dockerfile
   /addons/blueprint_builder/app/...
   ```
   Via SSH kan het ook, bijvoorbeeld:
   ```bash
   scp -r blueprint_builder root@<ha-ip>:/addons/
   ```
3. Ga naar **Instellingen → Add-ons → Add-on Store**.
4. Rechtsboven **⋮ → Controleren op updates**, herlaad de pagina.
5. Onder **Local add-ons** staat nu **Blueprint Builder** → **Installeren** (bouwt de image, duurt een paar minuten).
6. **Starten** en zet **Weergeven in zijbalk** aan.

## Gebruik

1. Open **Blueprints** in de zijbalk, kies een template en beantwoord de vragen.
2. Klik **Blueprint maken** → **Download YAML**.
3. Zet het bestand in `/config/blueprints/automation/eigen/` (via de Samba share **config**).
4. Ga naar **Instellingen → Automatiseringen en scènes → Blueprints**; de blueprint verschijnt daar (eventueel pagina herladen).

## Na een wijziging

Pas het `version`-nummer in `config.yaml` aan (bijv. `0.1.1`), dan **⋮ → Controleren op updates** en **Bijwerken** of **Opnieuw bouwen** in de add-on.

## Nieuwe template toevoegen

Maak een bestand in `app/templates/`, bijvoorbeeld `window-heating.js`, met dezelfde opbouw als `motion-light.js`:

- `id`, `name`, `description`
- `questions`: vragen (`text`, `number`, `boolean`, `select`), optioneel `showIf` en `options` als functie die HA-data krijgt
- `build(answers)`: geeft het blueprint-object terug; gebruik `input('naam')` voor `!input naam`

Na herbouwen verschijnt de template automatisch in de wizard.

## Lokaal testen buiten HA

```bash
cd app
HA_URL=http://<ha-ip>:8123 \
HA_WS_URL=ws://<ha-ip>:8123/api/websocket \
HA_TOKEN=<long-lived-token> \
node server.js
```
Open daarna http://localhost:8099 (Node 22 vereist).
