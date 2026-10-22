# Omnik pour Gladys Assistant

Connecteur non officiel, sans lien avec Omnik. Il lit votre onduleur solaire
Omnik sur votre réseau local, par son enregistreur Wi-Fi, sans cloud et sans
compte.

**Jamais testé avec un vrai onduleur Omnik** : il a été construit à partir de
la bibliothèque omnikinverter (celle de Home Assistant) et des exemples de ses
tests. Merci de signaler ce que vous voyez (voir « Retours » plus bas).

## Ce que vous obtenez

Un appareil Gladys par onduleur, nommé d'après son numéro de série :

| Fonction                          | Ce que c'est                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| Production solaire (W)            | la puissance produite maintenant ; 0 la nuit                                               |
| Énergie solaire du jour (kWh)     | le compteur du jour de l'onduleur, tel qu'il le donne                                      |
| Index de production solaire (kWh) | un index cumulatif pour le suivi énergétique de Gladys (production par demi-heure, revenu) |
| Onduleur éveillé                  | 1 quand l'onduleur produit ou est prêt, 0 en veille (la nuit)                              |
| Température de l'onduleur (°C)    | seulement avec la source tcp (les pages web ne la donnent pas)                             |

Lecture seule : l'intégration n'envoie jamais de commande à l'onduleur. Le
compteur total de l'onduleur n'est pas publié (voir « L'index d'énergie »).

## Mise en place

1. Trouvez l'adresse IP de l'enregistreur Wi-Fi de l'onduleur dans votre box
   (il apparaît comme un appareil de votre réseau). Donnez-lui une adresse
   fixe si possible.
2. Dans Gladys, ouvrez l'intégration, saisissez l'adresse (de jour : la nuit
   l'onduleur dort et ne répond pas), choisissez la source et enregistrez :
   - **js** (par défaut) : la page `/js/status.js`, donnée par la plupart des
     enregistreurs ;
   - **json** : la page `/status.json` ; certains enregistreurs n'y donnent pas
     de numéro de série (l'appareil est alors nommé d'après une empreinte de
     l'adresse : une nouvelle adresse fait un nouvel appareil ; préférez js
     s'il fonctionne) ;
   - **html** : la page `/status.html`, qui demande toujours le nom
     d'utilisateur et le mot de passe de la page web de l'enregistreur
     (souvent admin) ;
   - **tcp** : le port 8899, qui demande le numéro de série de l'enregistreur
     Wi-Fi (chiffres seulement, sur son étiquette ou dans sa page web ; pas le
     numéro de série de l'onduleur). Il donne aussi la température de
     l'onduleur.
     Si l'état dit que la réponse n'est pas l'état d'un onduleur Omnik, essayez
     une autre source.
3. Le nom d'utilisateur et le mot de passe, s'ils sont saisis, sont aussi
   envoyés aux sources js et json (certains enregistreurs les demandent). Le
   mot de passe est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
   seulement à l'enregistreur, en Basic auth sur du HTTP simple dans votre
   réseau (l'enregistreur n'a pas de HTTPS).
4. Ouvrez l'onglet « Découverte » et créez l'appareil. Ses valeurs arrivent à
   la lecture suivante (dans la minute, de jour).
5. Facultatif mais conseillé : saisissez la puissance crête de vos panneaux
   (kWc, sur la facture de l'installateur). Elle borne ce que l'index
   d'énergie peut prendre entre deux lectures. Laissée vide, elle est apprise
   depuis la puissance atteinte par l'onduleur sur une semaine (30 kW d'ici
   là, ce qui laisse passer plus de lectures aberrantes). Ne saisissez jamais
   moins que la vraie puissance crête (un long silence à midi pourrait alors
   faire perdre le reste de la journée) : dans le doute, laissez vide.

Le bouton « Tester la connexion » lit l'onduleur si une lecture est due, et
sinon donne la dernière lecture : l'intégration ne lit jamais plus d'une fois
par minute, quoi qui le demande.

## Un mot de passe refusé

Quand l'enregistreur refuse le nom d'utilisateur ou le mot de passe (HTTP 401
ou 403), l'intégration arrête de lire avec eux, définitivement, même après un
redémarrage : un mauvais mot de passe n'est jamais réessayé seul. Saisissez
les bons et enregistrez (les lectures reprennent à leur rythme), ou, si
l'enregistreur les accepte de nouveau, cliquez sur « Tester la connexion » :
une lecture, et le refus est levé en cas de succès. Seule une empreinte salée
d'un jeu refusé est gardée, effacée au premier succès ; jamais le mot de
passe.

## La nuit

Un onduleur Omnik est alimenté par ses panneaux : au coucher du soleil il
s'arrête, et son enregistreur Wi-Fi répond sans production ou se tait. Ce
n'est pas une erreur : après trois lectures sans réponse (ou tout de suite
quand l'enregistreur le dit), l'onduleur est « en veille », sa puissance passe
à 0, l'état reste vert et le dit, et il est lu toutes les 5 minutes jusqu'à
son réveil. L'état passe au rouge si l'onduleur disparaît (ou si son
enregistreur répond sans lui) en produisant 50 W ou plus, si un autre
enregistreur Wi-Fi répond à l'adresse, si la réponse n'est pas l'état d'un
onduleur, ou s'il n'y a aucune lecture depuis plus d'un jour ; après une heure
de silence il est de toute façon considéré en veille.

## L'index d'énergie

L'onduleur donne un compteur du jour (il repart chaque matin, au 0,01 kWh) et
un compteur total (au 0,1 kWh, pas fiable sur tous les firmwares), alors que
le suivi énergétique de Gladys compte les hausses d'un index cumulatif.
L'intégration construit cet index à partir du compteur du jour, avec le
mécanisme de l'intégration Zeversolar : l'index repart de sa dernière valeur
et ajoute ce qu'ajoute le compteur du jour. Il ne revient jamais à 0 et ne
baisse jamais : un nouveau jour (le compteur revenu à 0 le matin) le laisse
où il était. Quand l'onduleur réaffiche le compteur de la veille (au lever du
soleil, ou après un redémarrage dans la journée), cette valeur est tenue hors
de l'index et de l'énergie du jour. Les doutes sont tranchés du côté de
compter moins : un redémarrage de l'onduleur qui remet vraiment son compteur
à zéro dans la journée, un compteur qui saute (le reste de la journée peut
alors être perdu), des heures sans lecture autour du changement de jour, une
horloge mal réglée.

Risque restant (il compterait trop) : une valeur de la veille réaffichée à
plus de 0,1 kWh de la dernière valeur lue, au-dessus ou en dessous, ou toute
lecture fausse qui tient dans la puissance crête de l'installation depuis la
dernière lecture. Saisir la puissance crête garde cette marge petite. Et la
veille réaffichée moins de 0,1 kWh au-dessus du compteur du jour peut être
prise : 0,1 kWh au plus.

L'index passe aussi par une garde : un saut de l'index lui-même est retenu,
affiché dans l'état de l'intégration, et pris seulement quand vous cliquez
sur « Accepter l'index retenu » dans la configuration (il est alors compté
d'un coup). Une baisse de l'index n'est jamais acceptée : elle se corrige
seule, l'index reprend quand le compteur l'a rattrapé. Enregistrer la
configuration n'accepte jamais rien.

## Limites

- Un onduleur par enregistreur et par intégration.
- Production après minuit local (grand nord en juin, ou un fuseau de Gladys
  à l'est de la maison) : la remise à zéro du compteur tombe le même jour
  local et ce jour est sous-compté.
- Certains enregistreurs gardent les dernières valeurs la nuit : la puissance
  reste alors à sa dernière valeur jusqu'à ce que l'enregistreur se taise.
- L'intégration demande Gladys 5.2.0 ou plus récent.

## Vie privée

Rien ne sort de votre réseau : l'intégration ne parle qu'à l'adresse saisie,
avec une petite requête par minute (toutes les 5 minutes la nuit). De
l'identifiant de l'enregistreur, seule une courte empreinte est gardée (pour
distinguer un enregistreur d'un autre). Le nom d'utilisateur et le mot de
passe ne sont jamais journalisés, affichés ni écrits dans `/data`.

## Retours

Issues et pull requests : <https://github.com/LM1LC3N7/gladys-omnik>. Si vous
avez un onduleur Omnik, le texte de `http://<adresse>/js/status.js` (de jour
et de nuit, numéros de série masqués) aide beaucoup.
