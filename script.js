const d = ["Daft","Deadly","Debated","Decadent","Definitive","Diabetic","Diabolic","Diagonal","Dietetic","Different","Differential","Difficult","Diffuse","Digital","Dilated","Diluted","Dim","Dimensional","Dimensioned","Dire","Directive","Directory","Disadvantaged","Disallowable","Disappointed","Disappointing","Disarming","Discarnate","Deceptive","Discerning","Disciplinarian","Discomfit","Discontent","Discontinuous","Disinterested","Disparate","Displayed","Distinct","Docile","Doddering","Dogged","Doleful","Doltish","Domesticated","Done","Donor","Doomed","Doorless","Dormant","Dorsal","Double","Dour","Down","Downright","Downtrodden","Drab","Draconian","Draft","Drastic","Dreadful","Dreamless","Dressy","Dried","Driving","Drunk","Drunke","Dryer","Drying","Dual","Dubious","Dull","Duller","Duplicate","Dusk","Dying","Dancing","Dapper","Daring","Dashing","Dawning","Dear","Debonair","Debuting","Decent","Decided","Deciding","Decisive","Decontaminating","Decorative","Decorous","Dedicated","Defender","Defensible","Definite","Deft","Delectable","Delicious","Delighted","Delightful","Deluxe","Demonstrative","Demulcent","Demure","Dependable","Deserving","Desired","Detailed","Determinate","Developed","Developing","Devoted","Devotional","Dexterous","Diamond","Dignified","Dilatory","Diligent","Direct","Disciplined","Discovered","Discreet","Distinctive","Diverse","Divine","Doable","Dominant","Doting","Doubtless","Dream","Driven","Damaged","Damaging","Damp","Daunting","Dawdling","Dazed","Dead","Deaf","Deafening","Debatable","Decayed","Decaying","Declining","Decreasing","Defamatory","Defeated","Defective","Defenseless","Deformed","Degenerative","Degraded","Dejected","Delirious","Deluded","Demanding","Demented","Deplorable","Deploring","Depraved","Deprived","Deranged","Derogatory","Despairing","Desperate","Despicable","Despised","Despondent","Destroyed","Detestable","Detrimental","Devastated","Devastating","Devious","Digressive","Dilapidated","Diminishing","Diminutive","Disabled","Disaffected","Disagreeable","Disappearing","Disapproving","Disastrous","Discouraged","Disdainful","Diseased","Disgusted","Disgusting","Disliked","Disorderly","Displeased","Disproved","Disputed","Disreputable","Disrespectful","Distasteful","Domineering","Doubtful","Dreaded","Dauntless","Dazzling","Deceitful","Deferential","Defiant","Deliberate","Delicate","Demoralized","Depressed","Depressing","Despiteful","Detached","Determined","Devout","Diplomatic","Disbelieving","Disgruntled","Dishonest","Disillusioned","Dismayed","Dismaying","Disruptive","Dissatisfied","Distinguished","Distressed","Distrusted","Disturbed","Dramatic","Dreamy","Dangerous","Danish","Decrepit","Defense","Dehydrated","Delinquent","Democrat","Demonic","Dependent","Designer","Detectable","Dirty","Disarmed","Discarded","Disheveled","Dismal","Dispensable","Distant","Diverted","Domestic","Dowdy","Drained","Drenched","Dressed","Drooping","Droopy","Drugged","Dry","Dumb","Dusty","Dutch","Dwarf","Dwarfish"]
document.title += ' '+ d[Math.floor(Math.random() * d.length)]

const hover = () => {
    const w1 = document.querySelector("#w1");
    const w2 = document.querySelector("#w2");
    const cnt = document.querySelector("#cnt");
    const hm = document.querySelector("#hover-me");
    w1.classList.toggle('active');
    w2.classList.toggle('active');
    cnt.classList.toggle('active');
    hm.classList.toggle('active');
}

const leave = () => {
    const w1 = document.querySelector("#w1");
    const w2 = document.querySelector("#w2");
    const cnt = document.querySelector("#cnt");
    const hm = document.querySelector("#hover-me");
    w1.classList.toggle('active');
    w2.classList.toggle('active');
    cnt.classList.toggle('active');
    hm.classList.toggle('active');
}