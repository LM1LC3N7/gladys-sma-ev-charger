# SMA EV Charger

Affiche une borne **SMA EV Charger** (EVC7.4-1AC-10, EVC22-3AC-10) ou une
**SMA eCharger** dans Gladys par l'API web locale de la borne, sans cloud.
Intégration non officielle, sans lien avec SMA. **Jamais testé avec une vraie
borne** : elle a été écrite d'après les bibliothèques libres pysmaev et
ha-sma-ev-charger (utilisées par Home Assistant) et testée contre une borne
simulée. Vos retours sont les bienvenus.

## Ce que vous obtenez

Un appareil par borne (repéré par son numéro de série), avec :

- l'état (aucun véhicule, véhicule branché, en charge, charge arrêtée, borne
  verrouillée, défaut de la borne), le connecteur et l'état de charge, le
  véhicule branché, l'erreur signalée, le statut de la borne, le sélecteur
  rotatif ;
- le mode de charge (charge rapide, charge optimisée, charge avec consigne,
  arrêt de la charge) et « charge arrêtée » ;
- la puissance, le courant et la tension par phase ;
- l'**index d'énergie** de la borne (kWh, son compteur), pour l'onglet
  énergie de Gladys, et l'**énergie de la session** (kWh) ;
- la limite du courant de charge (A) ;
- **Arrêter la charge** (bouton), **Démarrer la charge** (bouton), **Régler
  le mode de charge** (liste) et **Régler le courant de charge** (liste).

Pas d'interrupteur : un « tout éteindre » (un assistant vocal, une scène) ne
peut pas démarrer ni arrêter une charge par erreur.

## Installation

1. Donnez à la borne une adresse IP fixe dans votre box.
2. Créez au besoin un utilisateur dans l'interface web de la borne. Pour
   tout lire et tout régler, l'utilisateur doit être **installateur ou
   administrateur** (d'après Home Assistant) : avec moins de droits, la borne
   peut refuser des valeurs ou les commandes, ce que l'état indique alors.
3. Dans Gladys, saisissez l'adresse (une adresse IPv4 ou un nom d'hôte,
   éventuellement `:port`, 443 par défaut), le **nom d'utilisateur et le mot
   de passe** (les deux sont nécessaires : l'un sans l'autre est refusé),
   enregistrez.
4. Ouvrez l'onglet **Découverte** et ajoutez la borne.

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, et
envoyé seulement à la borne, en HTTPS, une fois son certificat comparé à
celui épinglé à la première connexion. Il n'est jamais écrit dans les
journaux, dans `/data` ni dans un état, pas plus que le jeton d'accès que
donne la borne.

### Le certificat de la borne

La borne présente un certificat auto-signé. À la première connexion, son
empreinte SHA-256 est épinglée (gardée dans `/data`) **avant** l'envoi du mot
de passe ; ensuite chaque connexion lui est comparée avant d'écrire le
moindre octet. Si le certificat change (borne remplacée, mise à jour),
l'intégration n'envoie rien (le mot de passe non plus) et l'état affiche le
début de la nouvelle empreinte. Comparez-la avec celle que votre navigateur
montre sur l'interface web de la borne, puis cliquez deux fois sur **Faire
confiance au nouveau certificat** : le premier clic montre l'empreinte
entière, un second clic 3 à 60 secondes plus tard épingle exactement
celle-là. TLS 1.2 au minimum.

## Lectures

La borne est lue à chaque intervalle de rafraîchissement (30 s par défaut,
de 15 s à 1 h) : un jeton d'accès quand celui en mémoire est ancien (il sert
jusqu'à 90 % de sa durée, une heure par défaut), les mesures, puis les
paramètres. Chaque requête a sa propre connexion, fermée juste après. Jamais
plus tôt que l'intervalle : le bouton **Tester la connexion**, l'onglet
Découverte, une reconnexion à Gladys, une configuration enregistrée sans
changement ou un redémarrage ne lisent pas plus tôt (seules les deux
lectures 5 s et 20 s après une commande, et la lecture juste après de
nouveaux identifiants ou un certificat que vous avez approuvé, le font).

- **429** (la borne demande de ralentir) : pause du Retry-After, de 1 min à
  6 h (5 min sans), gardée dans `/data` ; **5xx** : une pause du délai
  d'échec (1 min au moins). Rien d'autre que « Arrêter la charge » n'est
  envoyé pendant une pause.
- **Identifiants refusés** (la demande de jeton répond 401, ou 400/403 avec
  une erreur OAuth comme `invalid_grant` ; un autre 400/403, d'un proxy ou
  d'un serveur occupé, est un échec ordinaire) :
  gardé dans `/data`, et **plus aucun essai automatique** (une borne peut
  verrouiller le compte après quelques mots de passe refusés). Enregistrer
  d'autres identifiants essaie aussitôt ; **Tester la connexion** essaie une
  fois de plus, au plus une fois par minute.
- Une valeur que la borne refuse de donner avec un jeton qu'elle vient de
  donner (401 ou 403) : l'utilisateur n'a pas les droits ; ce n'est pas un
  mot de passe refusé. Réessayé après 5 minutes, puis une attente qui double
  jusqu'à 1 heure.
- Injoignable : nouveaux essais après 30 s, 1, 2, puis 5 min, jamais plus
  tôt que l'intervalle.

## Commandes

### Arrêter la charge

**Arrêter la charge** (et le mode **Arrêt de la charge** de la liste) met le
mode de fonctionnement de la borne sur « Arrêt de la charge ». Elle ne
demande aucune option et n'est jamais retenue : ni par une commande en cours
(elle prend la borne aussitôt, et un démarrage, un mode ou un courant pas
encore envoyé est abandonné), ni par la minute entre deux changements, ni
par une pause 429 ou 5xx, ni par une lecture en échec ou figée (elle n'en a
pas besoin), ni avant la première lecture après un redémarrage (le numéro
de série de la borne est gardé dans `/data`), ni par un `/data` impossible à
écrire. Elle reste jusqu'à un démarrage (depuis Gladys avec l'option, depuis
l'application SMA, ou par le sélecteur rotatif) : **un arrêt oublié peut
empêcher la charge suivante**.

Quand l'arrêt n'est pas appliqué — la borne ne peut pas être jointe, lui
répond 429 ou 5xx, son certificat a changé, ou les identifiants sont
refusés — il est **gardé** dans `/data` et renvoyé à son propre rythme,
toutes les 30 secondes (après l'attente qu'un 429 demande, 5 minutes au
plus), quels que soient l'intervalle ou une pause des lectures, jusqu'à ce
que la borne le prenne. Il n'est jamais abandonné avec le temps : seuls une
lecture montrant la borne arrêtée, un démarrage envoyé depuis Gladys, un
autre mode que celui d'avant le clic lu deux fois de suite (un démarrage
venu d'ailleurs), une autre borne à l'adresse ou un refus de l'écriture par
la borne (4xx) y mettent fin. Avec des identifiants refusés, il n'est pas
envoyé avec les mêmes : il part en premier dès que d'autres identifiants
sont enregistrés ou que **Tester la connexion** réussit (un clic sur l'arrêt
tente aussi une connexion, au plus une fois par minute).

Après un arrêt, les lectures des 90 secondes suivantes surveillent la
borne : une lecture qui ne montre pas « Arrêt de la charge » alors qu'aucun
démarrage n'est parti de Gladys depuis renvoie l'arrêt, deux fois au plus ;
une fois qu'une lecture (celle juste après l'arrêt comprise) l'a montrée
arrêtée, un démarrage vu ensuite (depuis l'application SMA) est laissé
tranquille, sauf si un démarrage envoyé depuis Gladys juste avant l'arrêt
peut encore arriver.

L'arrêt est refusé, et non gardé, seulement :

- quand la configuration n'a jamais été lue auprès de Gladys (elle est
  redemandée sans fin ; après une reconnexion, la configuration lue avant
  continue de servir) ;
- sans adresse, nom d'utilisateur et mot de passe valables ;
- quand `/data` ne peut pas être lu (le certificat épinglé est inconnu) ;
- pour un appareil qui n'est pas la borne à l'adresse (une autre borne y a
  été lue) ;
- quand la borne refuse l'écriture elle-même (HTTP 4xx : droits de
  l'utilisateur).

### Démarrage, mode et courant (option)

**Démarrer la charge**, **Régler le mode de charge** (charge rapide ou
optimisée) et **Régler le courant de charge** sont **désactivés par
défaut** : activez « Autoriser le démarrage, le mode et le courant » dans la
configuration. Ensuite :

- chaque commande lit d'abord la borne (dans la même session) et se décide
  sur cette lecture, jamais sur les valeurs gardées en mémoire ; une valeur
  dont elle a besoin qui manque la fait refuser ;
- « Démarrer la charge » met la charge rapide ; elle est refusée sans
  véhicule branché, sur un défaut, une borne verrouillée ou un état inconnu,
  et quand la borne autorise moins de 6 A en ce moment ;
- « Charge optimisée » est refusée quand la borne ne la propose pas (elle
  demande un gestionnaire d'énergie comme le Sunny Home Manager). La charge
  avec consigne (une énergie et une heure de fin) est affichée, pas réglée ;
- le courant est un nombre entier d'ampères de 6 A (ou du minimum de la
  borne) à la plus basse des valeurs suivantes : le plafond de la
  configuration (16 A par défaut, 32 A au plus), le maximum que la borne
  donne pour sa limite de courant, et son courant nominal ;
- un démarrage, un mode ou un courant par minute (gardé dans `/data` avant
  que la commande parte : un `/data` impossible à écrire la fait refuser) ;
- l'option, le délai et le plafond sont revérifiés juste avant le départ de
  la commande ; un arrêt arrivé entre-temps l'emporte ;
- refusées pendant une pause 429/5xx ou avec des identifiants refusés.

### Réponses

Chaque commande part dans les 3,5 s suivant le clic ou est refusée **non
envoyée**. Une commande acceptée par la borne est confirmée par une lecture
juste après : la valeur demandée relue est un succès ; la valeur d'avant
encore lue est « pas encore appliquée » (revérifiée 5 et 20 secondes plus
tard) ; une commande qui a pu arriver sans réponse est « envoyée, sans
confirmation ». Un refus de la borne (4xx) est indiqué.

## Énergie

L'index d'énergie est le compteur de la borne (kWh). Une valeur de 0 ou une
baisse n'est **jamais** publiée, ni un saut plus grand que ce que la borne
peut délivrer (25 kW en moyenne depuis la dernière valeur, plus 0,5 kWh) : la
valeur est retenue, l'état et le badge de l'appareil le disent, et Gladys
garde la dernière valeur. **Accepter l'index retenu** la prend, en deux
clics : le premier montre la valeur retenue, un second 3 à 60 secondes plus
tard accepte exactement cela (pour un compteur remis à zéro ou remplacé). La
garde tourne sur une horloge que le réglage de l'heure par NTP ne déplace
pas. L'énergie de la session repart à chaque session : elle n'est jamais
publiée à 0 (la session précédente reste affichée jusqu'à ce que la nouvelle
ait délivré quelque chose).

Note : la borne est derrière votre compteur principal. Si Gladys compte déjà
toute la maison, l'index de la borne en est une part, pas un ajout.

## Limites

- Une borne par intégration. La consigne du mode de charge, la luminosité
  des voyants, la déconnexion en veille, la validation manuelle de la charge
  et le redémarrage de la borne ne sont pas gérés.
- Un arrêt envoyé avant la première lecture après un redémarrage a besoin
  de la configuration de Gladys (le mot de passe n'est jamais gardé dans
  `/data`).
- La fraîcheur repose sur les lectures : la borne ne donne pas l'heure de
  ses mesures.
- Un `/data` illisible arrête tout (rien n'est épinglé de nouveau à
  l'aveugle) ; il est relu à chaque intervalle.
- Jamais testé avec une vraie borne : les réponses d'une vraie (les modes
  proposés, les droits de chaque utilisateur, la durée du jeton) peuvent
  différer.
